/**
 * Sessions: refresh tokens are single-use, a lost answer is forgiven for a few seconds, a token that
 * comes back late is a theft, and signing out, changing the password, blocking and deleting end
 * sessions for real.
 */
import { decodeJwt, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import {
  GetRefreshTokenQuery,
  GetRefreshTokenQueryErrorCode,
  refreshTokensManager,
} from '@ryadom/core/managers/refresh-tokens-manager'
import { SetUserActiveCommand, usersManager } from '@ryadom/core/managers/users-manager'
import { ToggleUserActivationOperation, userManagementProcess } from '@ryadom/core/processes/user-management'
import type { LoginApiResponse } from '@ryadom/contracts/api/auth/shared'
import { RefreshApiErrorCode, type RefreshApiResponse } from '@ryadom/contracts/api/auth/refresh'
import { createJwt } from '../src/lib/jwt'
import { createSessions, REFRESH_GRACE_MS } from '../src/lib/sessions'
import { PASSWORD, call, codeFor, makeApp, ok, refusedWith, signUpAndIn } from './helpers'

const SECRET = process.env.MOBILE_JWT_SECRET ?? ''
const jwt = createJwt(SECRET)
const { app, resetLimits } = makeApp()

const DAY = 24 * 60 * 60 * 1000

const refresh = (refreshToken: string) =>
  call<RefreshApiResponse>(app, 'POST', '/api/auth/refresh', { refreshToken })

const logout = (refreshToken: string) => call(app, 'POST', '/api/auth/logout', { refreshToken })

/** Signs in again: a second device of the same person. */
async function signInAgain(email: string) {
  return ok<LoginApiResponse>(await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }))
    .tokens
}

/** Moves the clock: only Date is faked, the database driver needs real timers. */
function startClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date())
}
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

const sessionOf = (token: string) => decodeJwt(token).sid

describe('ротация refresh-токена', () => {
  it('refresh выдаёт новую пару в той же сессии, и новый токен тоже работает', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)

    const second = ok(await refresh(tokens.refreshToken))
    expect(second.refreshToken).not.toBe(tokens.refreshToken)
    // One session through every rotation, in both tokens: it is what lets a request name its session.
    expect(sessionOf(second.refreshToken)).toBe(sessionOf(tokens.refreshToken))
    expect(sessionOf(second.accessToken)).toBe(sessionOf(tokens.refreshToken))

    const third = ok(await refresh(second.refreshToken))
    expect(sessionOf(third.refreshToken)).toBe(sessionOf(tokens.refreshToken))
  })

  it('повтор того же токена сразу после ротации (ответ потерялся) получает новую пару', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)

    const first = ok(await refresh(tokens.refreshToken))
    const retry = ok(await refresh(tokens.refreshToken))

    expect(retry.refreshToken).not.toBe(first.refreshToken)
    expect(sessionOf(retry.refreshToken)).toBe(sessionOf(first.refreshToken))
    // Both successors are live: the client keeps whichever answer it got.
    ok(await refresh(first.refreshToken))
    ok(await refresh(retry.refreshToken))
  })

  it('два одновременных refresh одним токеном успешны оба и не принимаются за кражу', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const other = await signInAgain((await userOf(tokens.accessToken)).email)

    const [a, b] = await Promise.all([refresh(tokens.refreshToken), refresh(tokens.refreshToken)])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // No theft was assumed, so the person's other device is still signed in.
    ok(await refresh(other.refreshToken))
  })

  it('токен, вернувшийся после окна, — кража: 401, и сессии человека завершены все', async () => {
    resetLimits()
    startClock()
    const { user, tokens: laptop } = await signUpAndIn(app)
    const phone = await signInAgain(user.email)

    const rotated = ok(await refresh(laptop.refreshToken))
    advance(REFRESH_GRACE_MS + 1_000)
    expect((await refresh(laptop.refreshToken)).status).toBe(401)

    // Whoever holds the copy and the real client are both out; so is every other device.
    expect((await refresh(rotated.refreshToken)).status).toBe(401)
    expect((await refresh(phone.refreshToken)).status).toBe(401)
  })

  it('граница окна: ровно REFRESH_GRACE_MS ещё прощается', async () => {
    resetLimits()
    startClock()
    const { tokens } = await signUpAndIn(app)

    ok(await refresh(tokens.refreshToken))
    advance(REFRESH_GRACE_MS)
    expect((await refresh(tokens.refreshToken)).status).toBe(200)
  })

  it('токен без записи в реестре и токен без jti — 401', async () => {
    resetLimits()
    const { user } = await signUpAndIn(app)

    // Signed by us, but never registered: a refresh token is alive only if the registry says so.
    const unregistered = (await jwt.issueTokenPair(user.id)).refreshToken
    expect((await refresh(unregistered)).status).toBe(401)

    // Issued before sessions existed: no jti, so it can be neither rotated nor revoked.
    const legacy = await new SignJWT({ type: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setExpirationTime('30d')
      .sign(new TextEncoder().encode(SECRET))
    expect((await refresh(legacy)).status).toBe(401)
  })
})

describe('выход', () => {
  it('завершает сессию; остальные устройства человека остаются', async () => {
    resetLimits()
    const { user, tokens: laptop } = await signUpAndIn(app)
    const phone = await signInAgain(user.email)

    expect(ok(await logout(laptop.refreshToken))).toBeNull()

    expect((await refresh(laptop.refreshToken)).status).toBe(401)
    ok(await refresh(phone.refreshToken))
  })

  it('отвечает успехом всегда: повтор, чужая подпись, мусор', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)

    expect(ok(await logout(tokens.refreshToken))).toBeNull()
    expect(ok(await logout(tokens.refreshToken))).toBeNull()
    expect(ok(await logout('not-a-token'))).toBeNull()
    expect(
      ok(
        await logout(
          (await createJwt('another-secret-another-secret-0123456789').issueTokenPair('u')).refreshToken,
        ),
      ),
    ).toBeNull()
  })

  it('погашенный выходом токен не считается кражей и не трогает другие устройства', async () => {
    resetLimits()
    const { user, tokens: laptop } = await signUpAndIn(app)
    const phone = await signInAgain(user.email)
    await logout(laptop.refreshToken)

    // A stale tab of the signed-out laptop tries once more, long after the grace window.
    startClock()
    advance(REFRESH_GRACE_MS * 3)
    expect((await refresh(laptop.refreshToken)).status).toBe(401)

    ok(await refresh(phone.refreshToken))
  })

  it('выход сразу после ротации не оставляет лазейки: прежний токен в окне не воскресит сессию', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const next = ok(await refresh(tokens.refreshToken))

    await logout(next.refreshToken)

    // The first token was only rotated, and inside the grace window it would have been forgiven.
    expect((await refresh(tokens.refreshToken)).status).toBe(401)
    expect((await refresh(next.refreshToken)).status).toBe(401)
  })
})

describe('смена и сброс пароля', () => {
  it('смена пароля завершает остальные сессии, а текущая остаётся', async () => {
    resetLimits()
    const { user, tokens: laptop } = await signUpAndIn(app)
    const phone = await signInAgain(user.email)

    // The laptop changes the password; its access token names the session that stays.
    ok(
      await call(
        app,
        'POST',
        '/api/auth/password',
        { currentPassword: PASSWORD, newPassword: 'another-password-1' },
        laptop.accessToken,
      ),
    )

    ok(await refresh(laptop.refreshToken))
    expect((await refresh(phone.refreshToken)).status).toBe(401)
  })

  it('смена пароля с токеном без сессии (выдан до реестра) завершает все, и текущую тоже', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const legacyAccess = await jwt.signAccessToken(user.id)

    ok(
      await call(
        app,
        'POST',
        '/api/auth/password',
        { currentPassword: PASSWORD, newPassword: 'another-password-1' },
        legacyAccess,
      ),
    )

    expect((await refresh(tokens.refreshToken)).status).toBe(401)
  })

  it('неверный текущий пароль сессий не завершает', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = await signInAgain(user.email)

    const result = await call(
      app,
      'POST',
      '/api/auth/password',
      { currentPassword: 'wrong-password-here', newPassword: 'another-password-1' },
      tokens.accessToken,
    )
    expect(result.status).toBe(200)
    expect(result.envelope.status).toBe(false)

    ok(await refresh(tokens.refreshToken))
    ok(await refresh(phone.refreshToken))
  })

  it('сброс пароля по коду из письма завершает все сессии', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = await signInAgain(user.email)

    ok(await call(app, 'POST', '/api/auth/forgot-password', { email: user.email }))
    ok(
      await call(app, 'POST', '/api/auth/reset-password', {
        email: user.email,
        code: codeFor(user.email),
        newPassword: 'another-password-1',
      }),
    )

    expect((await refresh(tokens.refreshToken)).status).toBe(401)
    expect((await refresh(phone.refreshToken)).status).toBe(401)
  })
})

describe('блокировка и очистка реестра', () => {
  it('разблокировка не возвращает старую сессию: человек входит заново', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const toggle = () =>
      userManagementProcess.execute(
        new ToggleUserActivationOperation({ adminEmail: 'admin@example.com', userId: user.id }),
      )

    await toggle()
    await toggle()

    expect((await refresh(tokens.refreshToken)).status).toBe(401)
    ok(await call(app, 'POST', '/api/auth/login', { email: user.email, password: PASSWORD }))
  })

  it('отказ из-за состояния аккаунта не тратит токен', async () => {
    resetLimits()
    startClock()
    const { user, tokens } = await signUpAndIn(app)
    // Straight in the table, not through the admin scenario, which would end the sessions as well.
    const setActive = (isActive: boolean) =>
      usersManager.execute(new SetUserActiveCommand({ userId: user.id, isActive }))

    await setActive(false)
    refusedWith(await refresh(tokens.refreshToken), RefreshApiErrorCode.ACCOUNT_INACTIVE)

    // Past the grace window: had the refused call used the token up, it would come back as a theft.
    advance(REFRESH_GRACE_MS + 1_000)
    await setActive(true)
    ok(await refresh(tokens.refreshToken))
  })

  it('очистка убирает давно истёкшие токены и не трогает живые', async () => {
    resetLimits()
    startClock()
    const { tokens: old } = await signUpAndIn(app)
    const oldId = decodeJwt(old.refreshToken).jti!

    // 30 days of life plus more than a day of keeping it for the replay check.
    advance(32 * DAY)
    const { user } = await signUpAndIn(app)
    const fresh = await signInAgain(user.email)
    await createSessions(jwt).purgeExpired()

    const gone = await refreshTokensManager.execute(new GetRefreshTokenQuery({ tokenId: oldId }))
    expect(gone).toEqual({ success: false, error: GetRefreshTokenQueryErrorCode.TOKEN_NOT_FOUND })
    ok(await refresh(fresh.refreshToken))
  })
})

/** The account behind an access token, for tests that need its email. */
async function userOf(accessToken: string) {
  const me = ok<{ email: string }>(await call(app, 'GET', '/api/auth/me', undefined, accessToken))
  return me
}
