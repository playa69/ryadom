/**
 * The first screen's agreements: what is recorded, what is refused, and that a conversation with
 * the agent stays closed until all of them are on record.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { userConsents } from '@ryadom/db/schema'
import { getDb, ValidationError } from '../src/shared'
import { DeviceLoginOperation, authenticationProcess } from '../src/processes/authentication'
import {
  AcceptConsentsOperation,
  AcceptConsentsOperationErrorCode,
  GetConsentStatusOperation,
  consentsProcess,
} from '../src/processes/consents'
import { DeleteAccountOperation, accountDeletionProcess } from '../src/processes/account-deletion'
import { StartDialogOperation, StartDialogOperationErrorCode, dialogsProcess } from '../src/processes/dialogs'
import { OFFER_VERSION, acceptConsents, mockAgent, registerConfirmedUser } from './helpers'

const accept = (
  userId: string,
  overrides: Partial<ConstructorParameters<typeof AcceptConsentsOperation>[0]> = {},
) =>
  consentsProcess.execute(
    new AcceptConsentsOperation({
      userId,
      ageConfirmed: true,
      disclaimerAccepted: true,
      offerAccepted: true,
      offerVersion: OFFER_VERSION,
      ...overrides,
    }),
  )

const status = async (userId: string) =>
  (await consentsProcess.execute(new GetConsentStatusOperation({ userId }))).status

const rowsOf = (userId: string) => getDb().select().from(userConsents).where(eq(userConsents.userId, userId))

/** An anonymous account, the kind the first screen is shown to. */
async function anonymousUser() {
  const result = await authenticationProcess.execute(
    new DeviceLoginOperation({ deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }),
  )
  if (!result.success) throw new Error(`device sign-in failed: ${result.error}`)
  return result.user
}

describe('согласия', () => {
  it('три согласия пишутся вместе, с версией оферты и временем', async () => {
    const user = await anonymousUser()
    expect(await status(user.id)).toEqual({ completed: false, offerVersion: null })

    const result = await accept(user.id)

    expect(result.success).toBe(true)
    const rows = await rowsOf(user.id)
    expect(rows.map((row) => row.kind).sort()).toEqual(['age_confirmed', 'disclaimer', 'offer'])
    expect(new Set(rows.map((row) => row.version))).toEqual(new Set([OFFER_VERSION]))
    expect(await status(user.id)).toEqual({ completed: true, offerVersion: OFFER_VERSION })
  })

  it('повторное принятие не двигает дату первого и не плодит строки', async () => {
    const user = await anonymousUser()
    const first = await accept(user.id)
    const second = await accept(user.id)

    expect(first.success && second.success).toBe(true)
    if (first.success && second.success) expect(second.acceptedAt).toEqual(first.acceptedAt)
    expect(await rowsOf(user.id)).toHaveLength(3)
  })

  it('новая версия оферты дописывается, прежняя остаётся в истории', async () => {
    const user = await anonymousUser()
    await accept(user.id, { offerVersion: '2026-10-04' })
    await accept(user.id, { offerVersion: '2027-02-01' })

    expect(await rowsOf(user.id)).toHaveLength(6)
    expect(await status(user.id)).toEqual({ completed: true, offerVersion: '2027-02-01' })
  })

  it('«мне нет 18» — отдельный отказ, и ничего не записывается', async () => {
    const user = await anonymousUser()

    expect(await accept(user.id, { ageConfirmed: false })).toEqual({
      success: false,
      error: AcceptConsentsOperationErrorCode.AGE_RESTRICTED,
    })
    expect(await rowsOf(user.id)).toHaveLength(0)
  })

  it('без дисклеймера или без оферты не записывается ни одно из трёх', async () => {
    const user = await anonymousUser()

    for (const overrides of [{ disclaimerAccepted: false }, { offerAccepted: false }]) {
      expect(await accept(user.id, overrides)).toEqual({
        success: false,
        error: AcceptConsentsOperationErrorCode.CONSENT_DECLINED,
      })
    }
    expect(await rowsOf(user.id)).toHaveLength(0)
    expect((await status(user.id)).completed).toBe(false)
  })

  it('неполный набор не считается согласием', async () => {
    const user = await anonymousUser()
    await getDb().insert(userConsents).values({
      id: randomUUID(),
      userId: user.id,
      kind: 'age_confirmed',
      version: OFFER_VERSION,
    })

    expect(await status(user.id)).toEqual({ completed: false, offerVersion: null })
  })

  it('версия не в виде даты отвергается до записи', async () => {
    const user = await anonymousUser()

    for (const offerVersion of ['', 'latest', '2026-1-4', '2026-10-04T00:00']) {
      await expect(accept(user.id, { offerVersion })).rejects.toBeInstanceOf(ValidationError)
    }
    expect(await rowsOf(user.id)).toHaveLength(0)
  })

  it('несуществующему и удалённому аккаунту согласия не принимаются', async () => {
    mockAgent()
    expect(await accept('00000000-0000-4000-8000-000000000000')).toEqual({
      success: false,
      error: AcceptConsentsOperationErrorCode.USER_NOT_FOUND,
    })

    const user = await anonymousUser()
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))
    expect(await accept(user.id)).toEqual({
      success: false,
      error: AcceptConsentsOperationErrorCode.USER_NOT_FOUND,
    })
  })

  it('запись согласий переживает удаление аккаунта: это доказательство, что данные обрабатывались с согласия', async () => {
    mockAgent()
    const user = await anonymousUser()
    await accept(user.id)

    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))

    expect(await rowsOf(user.id)).toHaveLength(3)
  })
})

describe('разговор без согласий', () => {
  const start = (userId: string) => dialogsProcess.execute(new StartDialogOperation({ userId }))

  it('закрыт, и агента не беспокоят', async () => {
    const { calls } = mockAgent()
    const user = await anonymousUser()

    expect(await start(user.id)).toEqual({
      success: false,
      error: StartDialogOperationErrorCode.CONSENT_REQUIRED,
    })
    expect(calls).toHaveLength(0)
  })

  it('неполные согласия его не открывают', async () => {
    const { calls } = mockAgent()
    const user = await anonymousUser()
    await getDb()
      .insert(userConsents)
      .values([
        { id: randomUUID(), userId: user.id, kind: 'age_confirmed', version: OFFER_VERSION },
        { id: randomUUID(), userId: user.id, kind: 'offer', version: OFFER_VERSION },
      ])

    expect(await start(user.id)).toEqual({
      success: false,
      error: StartDialogOperationErrorCode.CONSENT_REQUIRED,
    })
    expect(calls).toHaveLength(0)
  })

  it('после принятия открывается', async () => {
    mockAgent()
    const user = await anonymousUser()
    await acceptConsents(user.id)

    expect((await start(user.id)).success).toBe(true)
  })

  it('зарегистрированный по почте тоже не обходит согласия', async () => {
    mockAgent()
    const user = await registerConfirmedUser({ consents: false })

    expect(await start(user.id)).toEqual({
      success: false,
      error: StartDialogOperationErrorCode.CONSENT_REQUIRED,
    })
  })
})
