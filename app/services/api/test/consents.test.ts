/**
 * The first screen over HTTP: the agreements are recorded for any account, the profile says whether
 * they are on record, and a conversation stays closed until they are. Then the other half of the
 * promise to anonymous accounts: one nobody opens is erased, and a session that renews itself counts
 * as being opened.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { users } from '@ryadom/db/schema'
import { getDb } from '@ryadom/core/shared'
import { StartDialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import {
  AcceptConsentsApiErrorCode,
  type AcceptConsentsApiResponse,
} from '@ryadom/contracts/api/auth/consents'
import type { DeviceLoginApiResponse } from '@ryadom/contracts/api/auth/device'
import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import type { RefreshApiResponse } from '@ryadom/contracts/api/auth/refresh'
import { ANONYMOUS_RETENTION_DAYS, POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { purgeInactiveAnonymous } from '../src/lib/anonymous-retention'
import { call, expectTransportError, makeApp, mockAgent, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()

const ALL = {
  ageConfirmed: true,
  disclaimerAccepted: true,
  offerAccepted: true,
  offerVersion: POLICY_VERSION,
}

function newDevice() {
  return { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }
}

const anonymous = async (device = newDevice()) =>
  ok(await call<DeviceLoginApiResponse>(app, 'POST', '/api/auth/device', device))

const me = async (accessToken: string) =>
  ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, accessToken))

const accept = (accessToken: string, body: object = ALL) =>
  call<AcceptConsentsApiResponse>(app, 'POST', '/api/auth/me/consents', body, accessToken)

const startDialog = (accessToken: string) => call(app, 'POST', '/api/dialogs', {}, accessToken)

describe('согласия по HTTP', () => {
  it('анонимный аккаунт до согласий: профиль говорит «нет», разговор закрыт, агента не трогают', async () => {
    resetLimits()
    const { calls } = mockAgent()
    const { tokens } = await anonymous()

    expect(await me(tokens.accessToken)).toMatchObject({ consentsCompleted: false, consentVersion: null })
    refusedWith(await startDialog(tokens.accessToken), StartDialogApiErrorCode.CONSENT_REQUIRED)
    expect(calls).toHaveLength(0)
  })

  it('после принятия профиль называет версию, а разговор открывается', async () => {
    resetLimits()
    mockAgent()
    const { tokens } = await anonymous()

    const accepted = ok(await accept(tokens.accessToken))

    expect(accepted.consentsCompleted).toBe(true)
    expect(new Date(accepted.acceptedAt).getTime()).toBeGreaterThan(0)
    expect(await me(tokens.accessToken)).toMatchObject({
      consentsCompleted: true,
      consentVersion: POLICY_VERSION,
    })
    expect(ok(await startDialog(tokens.accessToken))).toMatchObject({ dialogId: expect.any(String) })
  })

  it('то же для зарегистрированного по почте', async () => {
    resetLimits()
    mockAgent()
    const { tokens } = await signUpAndIn(app, undefined, { consents: false })

    refusedWith(await startDialog(tokens.accessToken), StartDialogApiErrorCode.CONSENT_REQUIRED)
    ok(await accept(tokens.accessToken))
    expect(ok(await startDialog(tokens.accessToken))).toMatchObject({ dialogId: expect.any(String) })
  })

  it('повторное принятие — успех с той же датой', async () => {
    resetLimits()
    const { tokens } = await anonymous()

    const first = ok(await accept(tokens.accessToken))
    const second = ok(await accept(tokens.accessToken))

    expect(second.acceptedAt).toBe(first.acceptedAt)
  })

  it('«мне нет 18» и неполное согласие — отказы с кодами, профиль остаётся «нет»', async () => {
    resetLimits()
    const { tokens } = await anonymous()

    refusedWith(
      await accept(tokens.accessToken, { ...ALL, ageConfirmed: false }),
      AcceptConsentsApiErrorCode.AGE_RESTRICTED,
    )
    refusedWith(
      await accept(tokens.accessToken, { ...ALL, disclaimerAccepted: false }),
      AcceptConsentsApiErrorCode.CONSENT_DECLINED,
    )
    refusedWith(
      await accept(tokens.accessToken, { ...ALL, offerAccepted: false }),
      AcceptConsentsApiErrorCode.CONSENT_DECLINED,
    )
    expect((await me(tokens.accessToken)).consentsCompleted).toBe(false)
  })

  it('версия не датой — 422, тело не той формы — 400, без токена — 401', async () => {
    resetLimits()
    const { tokens } = await anonymous()

    await expectTransportError(
      await app.request('/api/auth/me/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify({ ...ALL, offerVersion: 'latest' }),
      }),
      422,
    )
    await expectTransportError(
      await app.request('/api/auth/me/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify({ ageConfirmed: 'yes' }),
      }),
      400,
    )
    await expectTransportError(
      await app.request('/api/auth/me/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ALL),
      }),
      401,
    )
  })
})

describe('срок жизни анонимного аккаунта по HTTP', () => {
  const lastSeen = async (userId: string) =>
    (await getDb().select().from(users).where(eq(users.id, userId)))[0]!.lastActiveAt

  const setLastSeen = (userId: string, at: Date) =>
    getDb().update(users).set({ lastActiveAt: at }).where(eq(users.id, userId))

  it('обновление сессии считается: человек открывал приложение', async () => {
    resetLimits()
    const { user, tokens } = await anonymous()
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await setLastSeen(user.id, longAgo)

    const before = Date.now()
    ok<RefreshApiResponse>(
      await call(app, 'POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken }),
    )

    expect((await lastSeen(user.id)).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('неактивный аккаунт стирается, и его сессия больше не обновляется', async () => {
    resetLimits()
    mockAgent()
    const quiet = await anonymous()
    const active = await anonymous()
    await setLastSeen(
      quiet.user.id,
      new Date(Date.now() - (ANONYMOUS_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
    )

    expect(await purgeInactiveAnonymous()).toEqual({ purged: 1, failed: 0 })

    refusedWith(
      await call(app, 'POST', '/api/auth/refresh', { refreshToken: quiet.tokens.refreshToken }),
      'ACCOUNT_DELETED',
    )
    ok(await call(app, 'POST', '/api/auth/refresh', { refreshToken: active.tokens.refreshToken }))
  })
})
