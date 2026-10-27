/**
 * Account scenarios over HTTP against the real core and database.
 */
import { describe, expect, it } from 'vitest'
import { ToggleUserActivationOperation, userManagementProcess } from '@ryadom/core/processes/user-management'
import { getSentEmails } from '@ryadom/core/services/email-sender-service'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import { ChangePasswordApiErrorCode } from '@ryadom/contracts/api/auth/password'
import { RefreshApiErrorCode, type RefreshApiResponse } from '@ryadom/contracts/api/auth/refresh'
import { RegisterApiErrorCode, type RegisterApiResponse } from '@ryadom/contracts/api/auth/register'
import { ResetPasswordApiErrorCode } from '@ryadom/contracts/api/auth/reset-password'
import type { LoginApiResponse } from '@ryadom/contracts/api/auth/shared'
import {
  call,
  codeFor,
  makeApp,
  mockAgent,
  ok,
  PASSWORD,
  refusedWith,
  signUpAndIn,
  uniqueEmail,
} from './helpers'

const { app, resetLimits } = makeApp()

describe('регистрация и вход', () => {
  it('регистрация → код → вход → профиль → refresh', async () => {
    const email = uniqueEmail()
    const registered = ok<RegisterApiResponse>(
      await call(app, 'POST', '/api/auth/register', {
        email: `  ${email.toUpperCase()} `,
        password: PASSWORD,
        name: ' Аня ',
      }),
    )
    expect(registered).toEqual({ email, emailConfirmationRequired: true })

    // Before confirmation it is the same bare 401 as for a wrong password.
    expect((await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD })).status).toBe(401)

    expect(ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))).toBeNull()

    const { user, tokens } = ok<LoginApiResponse>(
      await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }),
    )
    expect(user).toMatchObject({ email, name: 'Аня' })

    const me = ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, tokens.accessToken))
    expect(me).toMatchObject({ id: user.id, email, name: 'Аня', isEmailConfirmed: true })
    expect(Number.isNaN(Date.parse(me.createdAt))).toBe(false)

    const refreshed = ok<RefreshApiResponse>(
      await call(app, 'POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken }),
    )
    // Every refresh token is single-use: the answer carries the next one.
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken)
    ok(await call(app, 'POST', '/api/auth/refresh', { refreshToken: refreshed.refreshToken }))
    expect(
      ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, refreshed.accessToken)).id,
    ).toBe(user.id)
  })

  it('неподтверждённую почту можно зарегистрировать заново: пароль нового владельца и новый код', async () => {
    resetLimits()
    const email = uniqueEmail()
    ok(
      await call(app, 'POST', '/api/auth/register', {
        email,
        password: 'someone-elses-password',
        name: 'Чужой',
      }),
    )
    ok(await call(app, 'POST', '/api/auth/register', { email, password: PASSWORD, name: 'Аня' }))

    ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))
    expect(
      (await call(app, 'POST', '/api/auth/login', { email, password: 'someone-elses-password' })).status,
    ).toBe(401)
    const { user } = ok<LoginApiResponse>(
      await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }),
    )
    expect(user).toMatchObject({ email, name: 'Аня' })
  })

  it('занятая почта и одноразовый домен — коды правил', async () => {
    resetLimits()
    const email = uniqueEmail()
    ok(await call(app, 'POST', '/api/auth/register', { email, password: PASSWORD, name: 'Аня' }))
    ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))
    refusedWith(
      await call(app, 'POST', '/api/auth/register', { email, password: PASSWORD, name: 'Боря' }),
      RegisterApiErrorCode.USER_ALREADY_EXISTS,
    )
    refusedWith(
      await call(app, 'POST', '/api/auth/register', {
        email: 'someone@mailinator.com',
        password: PASSWORD,
        name: 'Аня',
      }),
      RegisterApiErrorCode.DISPOSABLE_EMAIL,
    )
  })

  it('неверный код — код правила, повторная отправка даёт новый', async () => {
    resetLimits()
    const email = uniqueEmail()
    ok(await call(app, 'POST', '/api/auth/register', { email, password: PASSWORD, name: 'Аня' }))

    refusedWith(
      await call(app, 'POST', '/api/auth/confirm-email', { email, code: '000000' }),
      ConfirmEmailApiErrorCode.CODE_INVALID,
    )

    expect(ok(await call(app, 'POST', '/api/auth/resend-confirmation', { email }))).toBeNull()
    ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))

    // There is nothing left to confirm the second time.
    refusedWith(
      await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }),
      ConfirmEmailApiErrorCode.CODE_INVALID,
    )
  })

  it('смена имени: обрезка пробелов, пустое — 422', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const me = ok<MeApiResponse>(
      await call(app, 'PATCH', '/api/auth/me', { name: '  Анна  ' }, tokens.accessToken),
    )
    expect(me.name).toBe('Анна')
    expect((await call(app, 'PATCH', '/api/auth/me', { name: '   ' }, tokens.accessToken)).status).toBe(422)
    expect(
      (await call(app, 'PATCH', '/api/auth/me', { name: 'x'.repeat(65) }, tokens.accessToken)).status,
    ).toBe(422)
  })

  it('голос агента: по умолчанию мужской, меняется отдельно и вместе с именем, чужое значение — 400, пустое тело — 422', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const read = async () =>
      ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, tokens.accessToken))
    expect((await read()).voice).toBe('male')

    const female = ok<MeApiResponse>(
      await call(app, 'PATCH', '/api/auth/me', { voice: 'female' }, tokens.accessToken),
    )
    expect(female.voice).toBe('female')
    expect((await read()).voice).toBe('female')

    const both = ok<MeApiResponse>(
      await call(app, 'PATCH', '/api/auth/me', { name: 'Анна', voice: 'male' }, tokens.accessToken),
    )
    expect(both).toMatchObject({ name: 'Анна', voice: 'male' })

    // A value the schema does not know is a malformed body (400); a body with nothing to change is refused as such (422).
    for (const bad of [{ voice: 'robot' }, { voice: 1 }]) {
      expect((await call(app, 'PATCH', '/api/auth/me', bad, tokens.accessToken)).status).toBe(400)
    }
    expect((await call(app, 'PATCH', '/api/auth/me', {}, tokens.accessToken)).status).toBe(422)
    // A bad name next to a good voice changes nothing: the voice is not half-applied.
    expect(
      (await call(app, 'PATCH', '/api/auth/me', { name: '   ', voice: 'female' }, tokens.accessToken)).status,
    ).toBe(422)
    expect(await read()).toMatchObject({ name: 'Анна', voice: 'male' })
  })

  it('часовой пояс (REQ-WELL-01): по умолчанию Москва, меняется на известное имя IANA, чужое — 422', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const read = async () =>
      ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, tokens.accessToken))
    expect((await read()).timezone).toBe('Europe/Moscow')

    const changed = ok<MeApiResponse>(
      await call(app, 'PATCH', '/api/auth/me', { timezone: 'Asia/Yekaterinburg' }, tokens.accessToken),
    )
    expect(changed.timezone).toBe('Asia/Yekaterinburg')

    for (const bad of ['Mars/Olympus', '+03:00', '']) {
      expect((await call(app, 'PATCH', '/api/auth/me', { timezone: bad }, tokens.accessToken)).status).toBe(422)
    }
    // A refused zone next to a good name changes nothing.
    expect(
      (await call(app, 'PATCH', '/api/auth/me', { name: 'Анна', timezone: 'Mars/Olympus' }, tokens.accessToken))
        .status,
    ).toBe(422)
    expect((await read()).timezone).toBe('Asia/Yekaterinburg')
  })

  it('конкретный голос: по умолчанию голос рода, выбор задаёт и род, несовпадение и чужое имя — 400', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const read = async () =>
      ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, tokens.accessToken))
    const patch = (body: object) =>
      call<MeApiResponse>(app, 'PATCH', '/api/auth/me', body, tokens.accessToken)
    expect(await read()).toMatchObject({ voice: 'male', voiceName: 'Charon' })

    // The voice fixes the gender with it, without the client saying it twice.
    expect(ok<MeApiResponse>(await patch({ voiceName: 'Aoede' }))).toMatchObject({
      voice: 'female',
      voiceName: 'Aoede',
    })
    expect(await read()).toMatchObject({ voice: 'female', voiceName: 'Aoede' })
    expect(ok<MeApiResponse>(await patch({ voice: 'male', voiceName: 'Puck' }))).toMatchObject({
      voice: 'male',
      voiceName: 'Puck',
    })

    // The gender alone goes back to the default voice of that gender.
    expect(ok<MeApiResponse>(await patch({ voice: 'female' }))).toMatchObject({
      voice: 'female',
      voiceName: 'Kore',
    })

    // A name outside the catalog and a gender that disagrees with the name change nothing.
    expect((await patch({ voiceName: 'Robot' })).status).toBe(400)
    expect((await patch({ voice: 'male', voiceName: 'Aoede' })).status).toBe(400)
    expect(await read()).toMatchObject({ voice: 'female', voiceName: 'Kore' })
  })
})

describe('пароль', () => {
  it('смена: неверный текущий — код; верный — новый пароль работает', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    refusedWith(
      await call(
        app,
        'POST',
        '/api/auth/password',
        { currentPassword: 'nope-nope-nope', newPassword: 'new-password-1' },
        tokens.accessToken,
      ),
      ChangePasswordApiErrorCode.INVALID_CURRENT_PASSWORD,
    )
    expect(
      ok(
        await call(
          app,
          'POST',
          '/api/auth/password',
          { currentPassword: PASSWORD, newPassword: 'new-password-1' },
          tokens.accessToken,
        ),
      ),
    ).toBeNull()
    expect(
      (await call(app, 'POST', '/api/auth/login', { email: user.email, password: PASSWORD })).status,
    ).toBe(401)
    ok(await call(app, 'POST', '/api/auth/login', { email: user.email, password: 'new-password-1' }))
  })

  it('«не помню пароль»: код из письма меняет пароль, чужой код не подходит', async () => {
    resetLimits()
    const { user } = await signUpAndIn(app)

    expect(ok(await call(app, 'POST', '/api/auth/forgot-password', { email: user.email }))).toBeNull()
    const code = codeFor(user.email)

    refusedWith(
      await call(app, 'POST', '/api/auth/reset-password', {
        email: user.email,
        code: '000000',
        newPassword: 'another-password-1',
      }),
      ResetPasswordApiErrorCode.CODE_INVALID,
    )
    expect(
      ok(
        await call(app, 'POST', '/api/auth/reset-password', {
          email: user.email,
          code,
          newPassword: 'another-password-1',
        }),
      ),
    ).toBeNull()
    ok(await call(app, 'POST', '/api/auth/login', { email: user.email, password: 'another-password-1' }))
  })

  it('«не помню пароль» для неизвестной почты — тот же успех и ни одного письма', async () => {
    resetLimits()
    const stranger = uniqueEmail('nobody')
    expect(ok(await call(app, 'POST', '/api/auth/forgot-password', { email: stranger }))).toBeNull()
    expect(getSentEmails().some((sent) => sent.to === stranger)).toBe(false)
  })
})

describe('состояние аккаунта проверяет только refresh', () => {
  it('блокировка: access доживает, refresh — ACCOUNT_INACTIVE, вход — 401', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    await userManagementProcess.execute(
      new ToggleUserActivationOperation({ adminEmail: 'admin@example.com', userId: user.id }),
    )

    ok(await call(app, 'GET', '/api/auth/me', undefined, tokens.accessToken))
    refusedWith(
      await call(app, 'POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken }),
      RefreshApiErrorCode.ACCOUNT_INACTIVE,
    )
    expect(
      (await call(app, 'POST', '/api/auth/login', { email: user.email, password: PASSWORD })).status,
    ).toBe(401)
  })

  it('удаление аккаунта: данные стёрты у агента, повтор — успех, refresh — ACCOUNT_DELETED', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()

    expect(ok(await call(app, 'DELETE', '/api/auth/me', undefined, tokens.accessToken))).toBeNull()
    expect(
      calls.some((entry) => entry.method === 'DELETE' && entry.url.pathname === `/v1/users/${user.id}`),
    ).toBe(true)

    expect(ok(await call(app, 'DELETE', '/api/auth/me', undefined, tokens.accessToken))).toBeNull()
    refusedWith(
      await call(app, 'POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken }),
      RefreshApiErrorCode.ACCOUNT_DELETED,
    )
    expect(
      (await call(app, 'POST', '/api/auth/login', { email: user.email, password: PASSWORD })).status,
    ).toBe(401)

    // The email is free again for a new registration.
    ok(await call(app, 'POST', '/api/auth/register', { email: user.email, password: PASSWORD, name: 'Аня' }))
  })

  it('агент не стёр данные — 503, аккаунт остаётся', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    mockAgent({ 'DELETE http://agent.test/v1/users/*': () => new Response('{}', { status: 503 }) })

    const response = await app.request('/api/auth/me', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    expect(response.status).toBe(503)

    // The account is still there: signing in keeps working.
    ok(await call(app, 'POST', '/api/auth/login', { email: user.email, password: PASSWORD }))
  })
})
