/**
 * Anonymous accounts over HTTP: sign-in by device, the account without an address, and linking an
 * address that turns it into an ordinary one.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ChangePasswordApiErrorCode } from '@ryadom/contracts/api/auth/password'
import type { DeviceLoginApiResponse } from '@ryadom/contracts/api/auth/device'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { LinkEmailApiErrorCode, type LinkEmailApiResponse } from '@ryadom/contracts/api/auth/link-email'
import { ResetPasswordApiErrorCode } from '@ryadom/contracts/api/auth/reset-password'
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

  it('частоту нельзя обойти подменой X-Forwarded-For: считается адрес, дописанный прокси', async () => {
    resetLimits()
    const device = newDevice()
    // The proxy appends the address it accepted the connection from; whatever stands before it
    // the client wrote itself, and a new fake value on every request must not give a new bucket.
    const spoofed = (i: number) => ({ 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.7` })

    for (let i = 0; i < 30; i++) expect((await deviceLogin(device, spoofed(i))).status).toBe(200)
    expect((await deviceLogin(device, spoofed(99))).status).toBe(429)
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

    ok(
      await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }, tokens.accessToken),
    )

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
    ok(
      await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }, tokens.accessToken),
    )
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
    ok(
      await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }, tokens.accessToken),
    )
  })
})

describe('неподтверждённый адрес гостя и чужой ящик', () => {
  const OWNER_PASSWORD = 'owner-password-1'

  const register = (email: string) =>
    call(app, 'POST', '/api/auth/register', { email, password: OWNER_PASSWORD, name: 'Боря' })
  const confirm = (email: string, token?: string) =>
    call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }, token)

  it('регистрация этого адреса даёт новому человеку новый аккаунт, а гость остаётся нетронутым', async () => {
    resetLimits()
    const device = newDevice()
    const guest = ok(await deviceLogin(device))
    const email = uniqueEmail()
    ok(await link(guest.tokens.accessToken, { email, password: PASSWORD }))

    // The answer is the usual success: it does not tell that somebody held the address.
    expect(ok(await register(email))).toEqual({ email, emailConfirmationRequired: true })

    expect(await me(guest.tokens.accessToken)).toMatchObject({
      id: guest.user.id,
      email: null,
      isEmailConfirmed: false,
    })
    const again = ok(await deviceLogin(device))
    expect(again.isNewAccount).toBe(false)
    expect(again.user.id).toBe(guest.user.id)

    expect(ok(await confirm(email))).toBeNull()
    const owner = ok<LoginApiResponse>(
      await call(app, 'POST', '/api/auth/login', { email, password: OWNER_PASSWORD }),
    )
    expect(owner.user.id).not.toBe(guest.user.id)
    // The password the guest chose for that address opens nothing.
    expect((await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(401)
  })

  it('адрес, который привязал гость, подтверждается только из его собственной сессии', async () => {
    resetLimits()
    const guest = ok(await deviceLogin(newDevice()))
    const email = uniqueEmail()
    ok(await link(guest.tokens.accessToken, { email, password: PASSWORD }))
    const stranger = await signUpAndIn(app)

    // The owner of the mailbox has the code and still does not get the account.
    refusedWith(await confirm(email), ConfirmEmailApiErrorCode.CODE_INVALID)
    refusedWith(await confirm(email, stranger.tokens.accessToken), ConfirmEmailApiErrorCode.CODE_INVALID)
    expect(await me(guest.tokens.accessToken)).toMatchObject({ email, isEmailConfirmed: false })

    // A token that does not verify is a 401 for the client to refresh, not "nobody".
    expect((await confirm(email, 'not-a-token')).status).toBe(401)

    // The refusals left the code alone: the guest's own session confirms with it.
    expect(ok(await confirm(email, guest.tokens.accessToken))).toBeNull()
    const byEmail = ok<LoginApiResponse>(
      await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }),
    )
    expect(byEmail.user.id).toBe(guest.user.id)
  })

  it('повторная отправка кода и сброс пароля с чужого ящика гостевой аккаунт не отдают', async () => {
    resetLimits()
    const guest = ok(await deviceLogin(newDevice()))
    const email = uniqueEmail()
    ok(await link(guest.tokens.accessToken, { email, password: PASSWORD }))

    ok(await call(app, 'POST', '/api/auth/resend-confirmation', { email }))
    refusedWith(await confirm(email), ConfirmEmailApiErrorCode.CODE_INVALID)
    ok(await call(app, 'POST', '/api/auth/forgot-password', { email }))
    refusedWith(
      await call(app, 'POST', '/api/auth/reset-password', {
        email,
        code: '123456',
        newPassword: OWNER_PASSWORD,
      }),
      ResetPasswordApiErrorCode.CODE_INVALID,
    )
    expect((await call(app, 'POST', '/api/auth/login', { email, password: OWNER_PASSWORD })).status).toBe(401)
    expect(await me(guest.tokens.accessToken)).toMatchObject({ id: guest.user.id, isEmailConfirmed: false })
  })

  it('токен вышедшей сессии подтверждение не принимает: это 401', async () => {
    resetLimits()
    const guest = ok(await deviceLogin(newDevice()))
    const email = uniqueEmail()
    ok(await link(guest.tokens.accessToken, { email, password: PASSWORD }))
    ok(await call(app, 'POST', '/api/auth/logout', { refreshToken: guest.tokens.refreshToken }))

    expect((await confirm(email, guest.tokens.accessToken)).status).toBe(401)
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
