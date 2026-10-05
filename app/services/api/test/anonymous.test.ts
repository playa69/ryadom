/**
 * Anonymous accounts over HTTP: sign-in by device, the account without an address, and linking an
 * address that turns it into an ordinary one.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ChangePasswordApiErrorCode } from '@ryadom/contracts/api/auth/password'
import type { DeviceLoginApiResponse } from '@ryadom/contracts/api/auth/device'
import { LinkEmailApiErrorCode, type LinkEmailApiResponse } from '@ryadom/contracts/api/auth/link-email'
import { RefreshApiErrorCode } from '@ryadom/contracts/api/auth/refresh'
import type { LoginApiResponse } from '@ryadom/contracts/api/auth/shared'
import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import { ToggleUserActivationOperation, userManagementProcess } from '@ryadom/core/processes/user-management'
import {
  PASSWORD,
  call,
  codeFor,
  expectTransportError,
  makeApp,
  mockAgent,
  ok,
  refusedWith,
  signUpAndIn,
  uniqueEmail,
} from './helpers'

const { app, resetLimits } = makeApp()

function newDevice() {
  return { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }
}

const deviceLogin = (device: object, headers: Record<string, string> = {}) =>
  call<DeviceLoginApiResponse>(app, 'POST', '/api/auth/device', device, undefined, headers)

const me = async (accessToken: string) =>
  ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, accessToken))

const link = (accessToken: string, body: object) =>
  call<LinkEmailApiResponse>(app, 'POST', '/api/auth/email/link', body, accessToken)

describe('вход по устройству', () => {
  it('новое устройство получает аккаунт без почты и рабочую сессию', async () => {
    resetLimits()
    const device = newDevice()

    const result = ok(await deviceLogin(device))

    expect(result.isNewAccount).toBe(true)
    expect(result.user).toMatchObject({ email: null, name: null })
    expect(await me(result.tokens.accessToken)).toMatchObject({
      id: result.user.id,
      email: null,
      name: null,
      isEmailConfirmed: false,
    })
    // An ordinary session: the refresh token rotates like any other.
    ok(await call(app, 'POST', '/api/auth/refresh', { refreshToken: result.tokens.refreshToken }))
  })

  it('то же устройство возвращается в тот же аккаунт, сессия при этом новая', async () => {
    resetLimits()
    const device = newDevice()
    const first = ok(await deviceLogin(device))
    const second = ok(await deviceLogin(device))

    expect(second.isNewAccount).toBe(false)
    expect(second.user.id).toBe(first.user.id)
    expect(second.tokens.refreshToken).not.toBe(first.tokens.refreshToken)
    // Both sessions live: the first one is not signed out by the second.
    ok(await call(app, 'POST', '/api/auth/refresh', { refreshToken: first.tokens.refreshToken }))
  })

  it('неверный ключ, заблокированный аккаунт и чужая форма данных', async () => {
    resetLimits()
    const device = newDevice()
    const { user } = ok(await deviceLogin(device))

    await expectTransportError(
      await app.request('/api/auth/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...device, deviceKey: randomBytes(32).toString('base64url') }),
      }),
      401,
    )

    // A bad shape is our app's bug, not something a person fixes: 400, not 422.
    for (const body of [
      { ...device, deviceId: 'short' },
      { ...device, deviceKey: 'not url safe!' },
      { deviceId: device.deviceId },
      {},
    ]) {
      expect((await deviceLogin(body)).status).toBe(400)
    }

    await userManagementProcess.execute(
      new ToggleUserActivationOperation({ adminEmail: 'admin@example.com', userId: user.id }),
    )
    // Blocked looks the same as a wrong key.
    expect((await deviceLogin(device)).status).toBe(401)
  })

  it('частота ограничена: новые аккаунты нельзя плодить без конца', async () => {
    resetLimits()
    const device = newDevice()
    const headers = { 'X-Forwarded-For': '203.0.113.7' }

    for (let i = 0; i < 30; i++) expect((await deviceLogin(device, headers)).status).toBe(200)
    expect((await deviceLogin(device, headers)).status).toBe(429)
    // Another address is not affected.
    expect((await deviceLogin(device, { 'X-Forwarded-For': '203.0.113.8' })).status).toBe(200)
  })

  it('смена пароля у аккаунта без пароля — понятный отказ, а не сбой', async () => {
    resetLimits()
    const { tokens } = ok(await deviceLogin(newDevice()))

    refusedWith(
      await call(
        app,
        'POST',
        '/api/auth/password',
        { currentPassword: PASSWORD, newPassword: 'another-password-1' },
        tokens.accessToken,
      ),
      'USER_NOT_FOUND' satisfies `${ChangePasswordApiErrorCode}`,
    )
  })
})

describe('привязка почты', () => {
  it('почта и пароль, код из письма, и аккаунт входит по почте на другом устройстве', async () => {
    resetLimits()
    const { user, tokens } = ok(await deviceLogin(newDevice()))
    const email = uniqueEmail()

    expect(
      ok(await link(tokens.accessToken, { email: `  ${email.toUpperCase()} `, password: PASSWORD })),
    ).toEqual({
      email,
      emailConfirmationRequired: true,
    })
    expect(await me(tokens.accessToken)).toMatchObject({ email, isEmailConfirmed: false })
    // Until the code is entered the address does not open email sign-in.
    expect((await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(401)

    ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))

    const other = ok<LoginApiResponse>(
      await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }),
    )
    expect(other.user).toMatchObject({ id: user.id, email })
    expect(await me(other.tokens.accessToken)).toMatchObject({ id: user.id, isEmailConfirmed: true })
  })

  it('чужая почта, окончательная почта, одноразовая и кривая', async () => {
    resetLimits()
    const { tokens } = ok(await deviceLogin(newDevice()))
    const taken = (await signUpAndIn(app)).user.email

    refusedWith(
      await link(tokens.accessToken, { email: taken, password: PASSWORD }),
      LinkEmailApiErrorCode.EMAIL_TAKEN,
    )
    refusedWith(
      await link(tokens.accessToken, { email: 'someone@mailinator.com', password: PASSWORD }),
      LinkEmailApiErrorCode.DISPOSABLE_EMAIL,
    )
    expect((await link(tokens.accessToken, { email: 'not-an-email', password: PASSWORD })).status).toBe(422)
    expect((await link(tokens.accessToken, { email: uniqueEmail(), password: 'short' })).status).toBe(422)

    const email = uniqueEmail()
    ok(await link(tokens.accessToken, { email, password: PASSWORD }))
    ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))
    refusedWith(
      await link(tokens.accessToken, { email: uniqueEmail(), password: PASSWORD }),
      LinkEmailApiErrorCode.ALREADY_HAS_EMAIL,
    )
  })

  it('без токена — 401; заблокированный аккаунт — отказ с кодом', async () => {
    resetLimits()
    expect(
      (await call(app, 'POST', '/api/auth/email/link', { email: uniqueEmail(), password: PASSWORD })).status,
    ).toBe(401)

    const { user, tokens } = ok(await deviceLogin(newDevice()))
    await userManagementProcess.execute(
      new ToggleUserActivationOperation({ adminEmail: 'admin@example.com', userId: user.id }),
    )
    refusedWith(
      await link(tokens.accessToken, { email: uniqueEmail(), password: PASSWORD }),
      LinkEmailApiErrorCode.USER_INACTIVE,
    )
  })

  it('повторный запрос на ту же почту присылает новый код (пока она не подтверждена)', async () => {
    resetLimits()
    const { tokens } = ok(await deviceLogin(newDevice()))
    const email = uniqueEmail()

    ok(await link(tokens.accessToken, { email, password: PASSWORD }))
    ok(await link(tokens.accessToken, { email, password: PASSWORD }))

    // The usual "send the code again" works for a linked address too.
    ok(await call(app, 'POST', '/api/auth/resend-confirmation', { email }))
    ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))
  })
})

describe('удаление анонимного аккаунта', () => {
  it('стирает аккаунт; то же устройство начинает с чистого листа', async () => {
    resetLimits()
    mockAgent()
    const device = newDevice()
    const first = ok(await deviceLogin(device))

    expect(ok(await call(app, 'DELETE', '/api/auth/me', undefined, first.tokens.accessToken))).toBeNull()

    refusedWith(
      await call(app, 'POST', '/api/auth/refresh', { refreshToken: first.tokens.refreshToken }),
      RefreshApiErrorCode.ACCOUNT_DELETED,
    )
    const again = ok(await deviceLogin(device))
    expect(again.isNewAccount).toBe(true)
    expect(again.user.id).not.toBe(first.user.id)
  })
})
