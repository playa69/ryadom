/**
 * One erasure for every way an account goes: the person's own request, an administrator, and the clean-up of guest
 * accounts nobody opened. They differ in who may ask and in the reason written to the archive; what is erased, in
 * which order and in which transaction is the same (`account-deletion` «Что стирается в приложении», «Профиль и события
 * в аналитике», «Порядок стирания»; `data-retention` «Что стирает чистка гостевых аккаунтов»;
 * `admin-console` «Удаление аккаунта администратором»).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  auditLog,
  dialogShares,
  diarySummaries,
  memoryConsentEvents,
  moodCheckins,
  selfCheckConsentEvents,
  selfCheckResults,
  userDevices,
  users,
  widgetTokens,
} from '@ryadom/db/schema'
import { AgentUnavailableError, getDb } from '../src/shared'
import {
  DeleteAccountOperation,
  DeleteAccountOperationErrorCode,
  DeleteUserAccountOperation,
  DeleteUserAccountOperationErrorCode,
  PurgeInactiveAnonymousOperation,
  accountDeletionProcess,
} from '../src/processes/account-deletion'
import { DeviceLoginOperation, authenticationProcess } from '../src/processes/authentication'
import { refreshTokensManager } from '../src/managers/refresh-tokens-manager'
import {
  ERASE_PERSON_DELAY_SECONDS,
  getEnqueuedJobs,
  registerJobQueueTransport,
} from '../src/services/job-queue-service'
import { ADMIN_EMAIL, HOUR, getUserRow, json, mockAgent, mockFetch, registerConfirmedUser } from './helpers'

const DAY = 24 * HOUR
const RETENTION_DAYS = 90
const CONSENT_VERSION = '2026-10-20'

interface Account {
  id: string
  /** The address of the account, null for a guest. */
  email: string | null
}

interface Path {
  name: string
  /** `users.properties.deletion.reason` */
  reason: string
  make(): Promise<Account>
  erase(account: Account): Promise<void>
  /** What the same path answers when the account is already gone. */
  eraseAgain(account: Account): Promise<unknown>
  /** An administrator's deletion leaves its own entry in the audit log. */
  audited: boolean
}

async function guest(): Promise<Account> {
  const result = await authenticationProcess.execute(
    new DeviceLoginOperation({ deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }),
  )
  if (!result.success) throw new Error(`device sign-in failed: ${result.error}`)
  // Nobody has opened it for longer than the retention period.
  await getDb()
    .update(users)
    .set({ lastActiveAt: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY) })
    .where(eq(users.id, result.user.id))
  return { id: result.user.id, email: null }
}

const purge = () =>
  accountDeletionProcess.execute(
    new PurgeInactiveAnonymousOperation({
      inactiveSince: new Date(Date.now() - RETENTION_DAYS * DAY),
      limit: 100,
    }),
  )

const PATHS: Path[] = [
  {
    name: 'по просьбе человека',
    reason: 'user_request',
    make: async () => {
      const user = await registerConfirmedUser()
      return { id: user.id, email: user.email }
    },
    erase: async (account) => {
      expect(
        await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: account.id })),
      ).toEqual({
        success: true,
      })
    },
    eraseAgain: (account) =>
      accountDeletionProcess.execute(new DeleteAccountOperation({ userId: account.id })),
    audited: false,
  },
  {
    name: 'администратором',
    reason: 'admin_request',
    make: async () => {
      const user = await registerConfirmedUser()
      return { id: user.id, email: user.email }
    },
    erase: async (account) => {
      expect(
        await accountDeletionProcess.execute(
          new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: account.id }),
        ),
      ).toEqual({ success: true })
    },
    eraseAgain: (account) =>
      accountDeletionProcess.execute(
        new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: account.id }),
      ),
    audited: true,
  },
  {
    name: 'чисткой неактивных гостей',
    reason: 'anonymous_inactivity',
    make: guest,
    erase: async () => {
      expect(await purge()).toEqual({ success: true, purged: 1, failed: 0 })
    },
    eraseAgain: purge,
    audited: false,
  },
]

/** Everything the app keeps for a person, so that erasing it is visible: a row in each table the erasure empties. */
async function fill(account: Account): Promise<void> {
  const db = getDb()
  const userId = account.id
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY)
  await db.insert(dialogShares).values({
    id: randomUUID(),
    userId,
    dialogId: 'dialog-1',
    tokenHash: randomBytes(16).toString('hex'),
    expiresAt: new Date(Date.now() + DAY),
  })
  await db.insert(moodCheckins).values({ userId, localDate: '2026-10-20', mood: 4, source: 'app' })
  await db
    .insert(diarySummaries)
    .values({ userId, kind: 'week', periodStart: '2026-10-19', text: 'Итог недели.', status: 'ready' })
  await db.insert(widgetTokens).values({ userId, tokenHash: randomBytes(32) })
  await db.insert(selfCheckResults).values({
    userId,
    testId: 'swls',
    testVersion: 1,
    score: 21,
    band: 'average',
    takenAt: at(1),
  })
  // Memory was granted and then paused; the tests' results are kept with a consent: both consents are in force.
  await db.insert(memoryConsentEvents).values([
    { id: randomUUID(), userId, action: 'granted', version: CONSENT_VERSION, at: at(3) },
    { id: randomUUID(), userId, action: 'paused', version: CONSENT_VERSION, at: at(2) },
  ])
  await db
    .insert(selfCheckConsentEvents)
    .values({ id: randomUUID(), userId, action: 'granted', version: CONSENT_VERSION, at: at(2) })
}

async function rowsOf(account: Account) {
  const db = getDb()
  const userId = account.id
  const [shares, marks, summaries, tokens, results, devices] = await Promise.all([
    db.select().from(dialogShares).where(eq(dialogShares.userId, userId)),
    db.select().from(moodCheckins).where(eq(moodCheckins.userId, userId)),
    db.select().from(diarySummaries).where(eq(diarySummaries.userId, userId)),
    db.select().from(widgetTokens).where(eq(widgetTokens.userId, userId)),
    db.select().from(selfCheckResults).where(eq(selfCheckResults.userId, userId)),
    db.select().from(userDevices).where(eq(userDevices.userId, userId)),
  ])
  return {
    shares: shares.length,
    marks: marks.length,
    summaries: summaries.length,
    tokens: tokens.length,
    results: results.length,
    devices: devices.length,
  }
}

const memoryJournal = async (userId: string) =>
  (
    await getDb()
      .select()
      .from(memoryConsentEvents)
      .where(eq(memoryConsentEvents.userId, userId))
      .orderBy(asc(memoryConsentEvents.at))
  ).map((row) => `${row.action}:${row.version}`)

const selfCheckJournal = async (userId: string) =>
  (
    await getDb()
      .select()
      .from(selfCheckConsentEvents)
      .where(eq(selfCheckConsentEvents.userId, userId))
      .orderBy(asc(selfCheckConsentEvents.at))
  ).map((row) => `${row.action}:${row.version}`)

afterEach(() => vi.restoreAllMocks())

describe.each(PATHS)('стирание аккаунта $name', (path) => {
  it('стирает ссылки на разговоры, дневник, итоги недели, токены виджета, результаты самопроверок и устройства', async () => {
    mockAgent()
    const account = await path.make()
    await fill(account)
    expect(await rowsOf(account)).toMatchObject({ shares: 1, marks: 1, summaries: 1, tokens: 1, results: 1 })

    await path.erase(account)

    expect(await rowsOf(account)).toEqual({
      shares: 0,
      marks: 0,
      summaries: 0,
      tokens: 0,
      results: 0,
      devices: 0,
    })
    const row = await getUserRow(account.id)
    expect(row?.isDeleted).toBe(true)
    expect(row?.properties).toMatchObject({ deletion: { reason: path.reason, agent_data_erased: true } })
  })

  it('ставит стирание профиля в аналитике с выдержкой 30 секунд и ключом-человеком', async () => {
    mockAgent()
    const account = await path.make()

    await path.erase(account)

    expect(getEnqueuedJobs()).toEqual([
      expect.objectContaining({
        queue: 'analytics.erase-person',
        data: { userId: account.id },
        startAfterSeconds: ERASE_PERSON_DELAY_SECONDS,
        singletonKey: account.id,
      }),
    ])
  })

  it('отзывает согласия, которые были в силе, строкой revoked в их версии; журналы остаются', async () => {
    mockAgent()
    const account = await path.make()
    await fill(account)

    await path.erase(account)

    // A pause is not a withdrawal: the consent was in force, so the end of the account ends it.
    expect(await memoryJournal(account.id)).toEqual([
      `granted:${CONSENT_VERSION}`,
      `paused:${CONSENT_VERSION}`,
      `revoked:${CONSENT_VERSION}`,
    ])
    expect(await selfCheckJournal(account.id)).toEqual([
      `granted:${CONSENT_VERSION}`,
      `revoked:${CONSENT_VERSION}`,
    ])
  })

  it('согласие, которого нет или которое уже отозвано, второй раз не отзывается', async () => {
    mockAgent()
    const account = await path.make()
    await getDb()
      .insert(memoryConsentEvents)
      .values([
        {
          id: randomUUID(),
          userId: account.id,
          action: 'granted',
          version: CONSENT_VERSION,
          at: new Date(Date.now() - 2 * DAY),
        },
        {
          id: randomUUID(),
          userId: account.id,
          action: 'revoked',
          version: CONSENT_VERSION,
          at: new Date(Date.now() - DAY),
        },
      ])

    await path.erase(account)

    expect(await memoryJournal(account.id)).toEqual([
      `granted:${CONSENT_VERSION}`,
      `revoked:${CONSENT_VERSION}`,
    ])
    // The tests never had a consent: no journal, no row made up for the occasion.
    expect(await selfCheckJournal(account.id)).toEqual([])
  })

  it('пишет запись в журнале действий администратора только при удалении администратором', async () => {
    mockAgent()
    const account = await path.make()

    await path.erase(account)

    const entries = await getDb().select().from(auditLog)
    if (path.audited) {
      expect(entries.map((entry) => [entry.action, entry.targetUserId])).toEqual([
        ['USER_ACCOUNT_DELETED', account.id],
      ])
    } else {
      expect(entries).toEqual([])
    }
  })

  it('повторное стирание ничего не пишет второй раз: ни задачи, ни строк в журналах', async () => {
    mockAgent()
    const account = await path.make()
    await fill(account)
    await path.erase(account)

    await path.eraseAgain(account)

    expect(getEnqueuedJobs()).toHaveLength(1)
    expect(await memoryJournal(account.id)).toHaveLength(3)
    expect(await selfCheckJournal(account.id)).toHaveLength(2)
  })

  it('агент не стёр данные — аккаунт и всё, что в нём, остаётся нетронутым, задачи нет', async () => {
    const account = await path.make()
    await fill(account)
    mockFetch({ 'DELETE http://agent.test/v1/users/*': () => json({ error: 'boom' }, 503) })

    // The purge counts the failure and goes on; the other two answer with the exception of the agent.
    if (path.reason === 'anonymous_inactivity')
      expect(await purge()).toEqual({ success: true, purged: 0, failed: 1 })
    else await expect(path.erase(account)).rejects.toBeInstanceOf(AgentUnavailableError)

    expect((await getUserRow(account.id))?.isDeleted).toBe(false)
    expect(await rowsOf(account)).toMatchObject({ shares: 1, marks: 1, summaries: 1, tokens: 1, results: 1 })
    expect(await memoryJournal(account.id)).toHaveLength(2)
    expect(await selfCheckJournal(account.id)).toHaveLength(1)
    expect(await getDb().select().from(auditLog)).toEqual([])
    expect(getEnqueuedJobs()).toEqual([])
  })

  it('сбой на последнем шаге транзакции откатывает всё стирание: задачи нет, строки и журналы на месте', async () => {
    mockAgent()
    const account = await path.make()
    await fill(account)
    // The sessions end near the end of the transaction, after everything else has been erased.
    vi.spyOn(refreshTokensManager, 'execute').mockRejectedValueOnce(new Error('the database failed'))

    if (path.reason === 'anonymous_inactivity')
      expect(await purge()).toEqual({ success: true, purged: 0, failed: 1 })
    else await expect(path.erase(account)).rejects.toThrow('the database failed')

    expect((await getUserRow(account.id))?.isDeleted).toBe(false)
    expect(await rowsOf(account)).toMatchObject({ shares: 1, marks: 1, summaries: 1, tokens: 1, results: 1 })
    expect(await memoryJournal(account.id)).toHaveLength(2)
    expect(await selfCheckJournal(account.id)).toHaveLength(1)
    expect(await getDb().select().from(auditLog)).toEqual([])
    expect(getEnqueuedJobs()).toEqual([])
  })

  it('очередь недоступна — стирание не проходит целиком, а не наполовину', async () => {
    mockAgent()
    const account = await path.make()
    await fill(account)
    registerJobQueueTransport(undefined)

    if (path.reason === 'anonymous_inactivity')
      expect(await purge()).toEqual({ success: true, purged: 0, failed: 1 })
    else await expect(path.erase(account)).rejects.toThrow('No job queue transport')

    expect((await getUserRow(account.id))?.isDeleted).toBe(false)
    expect(await rowsOf(account)).toMatchObject({ shares: 1, marks: 1, summaries: 1, tokens: 1, results: 1 })
  })
})

describe('отказы стирания по причинам', () => {
  it('неизвестный и уже удалённый аккаунт — коды отказа каждого пути', async () => {
    mockAgent()
    const unknown = '00000000-0000-4000-8000-000000000000'
    expect(await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: unknown }))).toEqual({
      success: false,
      error: DeleteAccountOperationErrorCode.USER_NOT_FOUND,
    })
    expect(
      await accountDeletionProcess.execute(
        new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: unknown }),
      ),
    ).toEqual({ success: false, error: DeleteUserAccountOperationErrorCode.USER_NOT_FOUND })

    const user = await registerConfirmedUser()
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))
    expect(
      await accountDeletionProcess.execute(
        new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
      ),
    ).toEqual({ success: false, error: DeleteUserAccountOperationErrorCode.ALREADY_DELETED })
  })

  it('гость, который вернулся до чистки, не стирается ничем из этого', async () => {
    mockAgent()
    const returned = await guest()
    await getDb().update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, returned.id))
    await fill(returned)

    expect(await purge()).toEqual({ success: true, purged: 0, failed: 0 })

    expect((await getUserRow(returned.id))?.isDeleted).toBe(false)
    expect(await rowsOf(returned)).toMatchObject({ shares: 1, marks: 1, results: 1 })
    expect(getEnqueuedJobs()).toEqual([])
  })
})
