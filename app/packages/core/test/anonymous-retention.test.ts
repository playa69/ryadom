/**
 * How long an anonymous account lives: what counts as the person being seen, which accounts are
 * erased after the quiet period, and that an address or a block keeps an account out of it.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { userDevices, users } from '@ryadom/db/schema'
import { getDb } from '../src/shared'
import {
  DeviceLoginOperation,
  LinkEmailOperation,
  authenticationProcess,
} from '../src/processes/authentication'
import { ListInactiveAnonymousUsersQuery, usersManager } from '../src/managers/users-manager'
import {
  DeleteAccountOperation,
  PurgeInactiveAnonymousOperation,
  accountDeletionProcess,
} from '../src/processes/account-deletion'
import { StartDialogOperation, dialogsProcess } from '../src/processes/dialogs'
import { ConfirmEmailOperation, emailConfirmationProcess } from '../src/processes/email-confirmation'
import {
  PASSWORD,
  HOUR,
  MINUTE,
  acceptConsents,
  blockDirectly,
  codeFromEmail,
  confirmWithCode,
  getUserRow,
  json,
  lastEmailTo,
  login,
  mockAgent,
  noContent,
  registerConfirmedUser,
  travelBy,
  uniqueEmail,
} from './helpers'

const DAY = 24 * HOUR
const RETENTION_DAYS = 90

const newDevice = () => ({ deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') })
const deviceLogin = (device: { deviceId: string; deviceKey: string }) =>
  authenticationProcess.execute(new DeviceLoginOperation(device))

/** An anonymous account whose person was last seen `daysAgo` days ago. */
async function anonymousSeen(daysAgo: number, device = newDevice()) {
  const result = await deviceLogin(device)
  if (!result.success) throw new Error(`device sign-in failed: ${result.error}`)
  await setLastSeen(result.user.id, new Date(Date.now() - daysAgo * DAY))
  return { user: result.user, device }
}

const setLastSeen = (userId: string, at: Date) =>
  getDb().update(users).set({ lastActiveAt: at }).where(eq(users.id, userId))

const lastSeen = async (userId: string) => (await getUserRow(userId))!.lastActiveAt

const purge = (limit = 100) =>
  accountDeletionProcess.execute(
    new PurgeInactiveAnonymousOperation({
      inactiveSince: new Date(Date.now() - RETENTION_DAYS * DAY),
      limit,
    }),
  )

describe('когда человека видели', () => {
  it('вход по почте отмечает это', async () => {
    const user = await registerConfirmedUser()
    await setLastSeen(user.id, new Date(Date.now() - 10 * DAY))

    const before = Date.now()
    expect((await login(user.email)).success).toBe(true)

    expect((await lastSeen(user.id)).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('вход по устройству отмечает это', async () => {
    const { user, device } = await anonymousSeen(30)

    const before = Date.now()
    expect((await deviceLogin(device)).success).toBe(true)

    expect((await lastSeen(user.id)).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('начало разговора отмечает это', async () => {
    mockAgent()
    const user = await registerConfirmedUser()
    await setLastSeen(user.id, new Date(Date.now() - 10 * DAY))

    const before = Date.now()
    expect((await dialogsProcess.execute(new StartDialogOperation({ userId: user.id }))).success).toBe(true)

    expect((await lastSeen(user.id)).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('чаще раза в час не пишется: сессия обновляется каждые четверть часа', async () => {
    const { user, device } = await anonymousSeen(0)
    const recent = new Date(Date.now() - 10 * MINUTE)
    await setLastSeen(user.id, recent)

    await deviceLogin(device)
    expect(await lastSeen(user.id)).toEqual(recent)

    travelBy(2 * HOUR)
    await deviceLogin(device)
    expect((await lastSeen(user.id)).getTime()).toBeGreaterThan(recent.getTime())
  })
})

describe('кого считают анонимным и неактивным', () => {
  it('список — только тихие аккаунты с ключом устройства и неподтверждённой почтой, не заблокированные', async () => {
    const quiet = await anonymousSeen(RETENTION_DAYS + 5)
    const seenRecently = await anonymousSeen(RETENTION_DAYS - 5)
    const blocked = await anonymousSeen(RETENTION_DAYS + 5)
    await blockDirectly(blocked.user.id)
    // An address that was confirmed, with a device row left behind by stale data.
    const confirmed = await anonymousSeen(RETENTION_DAYS + 5)
    await getDb().update(users).set({ isEmailConfirmed: true }).where(eq(users.id, confirmed.user.id))
    // Registered by email: no device at all, however long it has been quiet.
    const registered = await registerConfirmedUser()
    await setLastSeen(registered.id, new Date(Date.now() - 400 * DAY))
    // Already erased.
    mockAgent()
    const gone = await anonymousSeen(RETENTION_DAYS + 5)
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: gone.user.id }))

    const { users: listed } = await usersManager.execute(
      new ListInactiveAnonymousUsersQuery({
        inactiveSince: new Date(Date.now() - RETENTION_DAYS * DAY),
        limit: 100,
      }),
    )

    expect(listed.map((user) => user.id)).toEqual([quiet.user.id])
    expect(seenRecently.user.id).not.toBe(quiet.user.id)
  })

  it('самые давние — первыми, и не больше лимита', async () => {
    const newer = await anonymousSeen(RETENTION_DAYS + 2)
    const oldest = await anonymousSeen(RETENTION_DAYS + 9)
    const middle = await anonymousSeen(RETENTION_DAYS + 5)

    const { users: listed } = await usersManager.execute(
      new ListInactiveAnonymousUsersQuery({
        inactiveSince: new Date(Date.now() - RETENTION_DAYS * DAY),
        limit: 2,
      }),
    )

    expect(listed.map((user) => user.id)).toEqual([oldest.user.id, middle.user.id])
    expect(newer.user.id).not.toBe(oldest.user.id)
  })
})

describe('срок жизни анонимного аккаунта', () => {
  it('аккаунт, который не открывали дольше срока, стирается целиком', async () => {
    const { calls } = mockAgent()
    const { user, device } = await anonymousSeen(RETENTION_DAYS + 1)

    expect(await purge()).toEqual({ success: true, purged: 1, failed: 0 })

    const row = await getUserRow(user.id)
    expect(row).toMatchObject({ isDeleted: true, email: expect.stringContaining('anonymized') })
    expect(await getDb().select().from(userDevices).where(eq(userDevices.userId, user.id))).toHaveLength(0)
    // The agent erased its copy: the account is not declared gone while it still holds one.
    const erased = calls.filter((call) => call.method === 'DELETE').map((call) => call.url.pathname)
    expect(erased).toEqual([`/v1/users/${user.id}`])
    // The old key leads nowhere: the same device starts over with an account of its own.
    const again = await deviceLogin(device)
    expect(again.success && again.isNewAccount).toBe(true)
  })

  it('причина записана в архив удалённого', async () => {
    mockAgent()
    const { user } = await anonymousSeen(RETENTION_DAYS + 1)

    await purge()

    const row = await getUserRow(user.id)
    expect(row?.properties).toMatchObject({
      deletion: { reason: 'anonymous_inactivity', agent_data_erased: true },
    })
  })

  it('кого видели позже границы — остаётся', async () => {
    const { calls } = mockAgent()
    const { user } = await anonymousSeen(RETENTION_DAYS - 1)

    expect(await purge()).toEqual({ success: true, purged: 0, failed: 0 })

    expect((await getUserRow(user.id))?.isDeleted).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('вернувшийся человек начинает срок заново', async () => {
    mockAgent()
    const { user, device } = await anonymousSeen(RETENTION_DAYS - 1)
    travelBy(3 * DAY)
    await deviceLogin(device)

    travelBy(RETENTION_DAYS * DAY - 4 * DAY)
    expect(await purge()).toMatchObject({ purged: 0 })
    expect((await getUserRow(user.id))?.isDeleted).toBe(false)
  })

  it('с подтверждённой почтой аккаунт остаётся: в него можно войти откуда угодно', async () => {
    const { calls } = mockAgent()
    const registered = await registerConfirmedUser()
    await setLastSeen(registered.id, new Date(Date.now() - 400 * DAY))

    expect(await purge()).toMatchObject({ purged: 0 })

    expect((await getUserRow(registered.id))?.isDeleted).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('с привязанным Telegram аккаунт остаётся: Mini App откроет его с любого устройства', async () => {
    const { calls } = mockAgent()
    const { user } = await anonymousSeen(RETENTION_DAYS + 1)
    await getDb().update(users).set({ telegramId: 7_000_000_001 }).where(eq(users.id, user.id))

    expect(await purge()).toMatchObject({ purged: 0 })

    expect((await getUserRow(user.id))?.isDeleted).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('заблокированный остаётся: это решение админа, а не истечение срока', async () => {
    mockAgent()
    const { user } = await anonymousSeen(RETENTION_DAYS + 1)
    await blockDirectly(user.id)

    expect(await purge()).toMatchObject({ purged: 0 })

    expect((await getUserRow(user.id))?.isDeleted).toBe(false)
  })

  it('привязанная, но не подтверждённая почта аккаунт не спасает, и пароль с кодом уходят вместе с ним', async () => {
    mockAgent()
    const { user } = await anonymousSeen(RETENTION_DAYS + 1)
    const email = uniqueEmail('pending')
    expect(
      (
        await authenticationProcess.execute(
          new LinkEmailOperation({ userId: user.id, email, password: PASSWORD }),
        )
      ).success,
    ).toBe(true)
    await setLastSeen(user.id, new Date(Date.now() - (RETENTION_DAYS + 1) * DAY))

    expect(await purge()).toMatchObject({ purged: 1 })

    expect((await getUserRow(user.id))?.isDeleted).toBe(true)
    // The address is free again, and the code sent to it no longer works.
    const code = codeFromEmail(lastEmailTo(email))
    const confirmed = await emailConfirmationProcess.execute(new ConfirmEmailOperation({ email, code }))
    expect(confirmed.success).toBe(false)
  })

  it('агент не ответил — аккаунт остаётся до следующего прогона, остальные не страдают', async () => {
    const stuck = await anonymousSeen(RETENTION_DAYS + 2)
    const other = await anonymousSeen(RETENTION_DAYS + 1)
    let agentUp = false
    mockAgent({
      'DELETE http://agent.test/v1/users/*': (call) =>
        !agentUp && call.url.pathname.endsWith(stuck.user.id) ? json({}, 503) : noContent(),
    })

    expect(await purge()).toEqual({ success: true, purged: 1, failed: 1 })
    expect((await getUserRow(stuck.user.id))?.isDeleted).toBe(false)
    expect((await getUserRow(other.user.id))?.isDeleted).toBe(true)

    agentUp = true
    expect(await purge()).toEqual({ success: true, purged: 1, failed: 0 })
    expect((await getUserRow(stuck.user.id))?.isDeleted).toBe(true)
  })

  it('за один прогон — не больше лимита, остальные в следующем', async () => {
    mockAgent()
    for (const days of [RETENTION_DAYS + 3, RETENTION_DAYS + 2, RETENTION_DAYS + 1]) await anonymousSeen(days)

    expect(await purge(2)).toMatchObject({ purged: 2 })
    expect(await purge(2)).toMatchObject({ purged: 1 })
    expect(await purge(2)).toMatchObject({ purged: 0 })
  })

  it('уже удалённый не берётся повторно', async () => {
    const { calls } = mockAgent()
    await anonymousSeen(RETENTION_DAYS + 1)

    await purge()
    const erasedOnce = calls.filter((call) => call.method === 'DELETE').length
    await purge()

    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(erasedOnce)
  })
})

describe('подтверждённая почта и ключ устройства', () => {
  it('подтверждение почты забывает устройства аккаунта: выход на общем телефоне — это выход', async () => {
    const { user, device } = await anonymousSeen(0)
    const email = uniqueEmail('linked')
    await authenticationProcess.execute(
      new LinkEmailOperation({ userId: user.id, email, password: PASSWORD }),
    )
    expect(await getDb().select().from(userDevices).where(eq(userDevices.userId, user.id))).toHaveLength(1)

    await confirmWithCode(email)

    expect(await getDb().select().from(userDevices).where(eq(userDevices.userId, user.id))).toHaveLength(0)
    // The same key now makes a stranger's account, not this one.
    const again = await deviceLogin(device)
    expect(again.success && again.isNewAccount).toBe(true)
    expect(again.success && again.user.id).not.toBe(user.id)
  })

  it('даже оставшийся в базе ключ аккаунт с подтверждённой почтой не открывает', async () => {
    const { user, device } = await anonymousSeen(0)
    // A row that confirming should have removed, put back by hand: the sign-in refuses on its own.
    await getDb().update(users).set({ isEmailConfirmed: true }).where(eq(users.id, user.id))

    expect(await deviceLogin(device)).toEqual({ success: false, error: 'DEVICE_KEY_INVALID' })
  })

  it('согласия не мешают: аккаунту с подтверждённой почтой разговор открыт, если он согласился', async () => {
    mockAgent()
    const { user } = await anonymousSeen(0)
    await acceptConsents(user.id)
    const email = uniqueEmail('linked')
    await authenticationProcess.execute(
      new LinkEmailOperation({ userId: user.id, email, password: PASSWORD }),
    )
    await confirmWithCode(email)

    const result = await dialogsProcess.execute(new StartDialogOperation({ userId: user.id }))
    expect(result.success).toBe(true)
  })
})
