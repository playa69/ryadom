/**
 * Changing the password with the current one, and resetting it with a code from email
 *.
 */
import { describe, expect, it } from 'vitest'
import {
  ChangePasswordOperation,
  ChangePasswordOperationErrorCode,
  changePasswordProcess,
} from '../src/processes/change-password'
import {
  ForgotPasswordOperation,
  forgotPasswordProcess,
  ResetPasswordOperation,
  ResetPasswordOperationErrorCode,
} from '../src/processes/forgot-password'
import { LoginOperationErrorCode } from '../src/processes/authentication'
import {
  blockDirectly,
  codeFromEmail,
  codeRows,
  emailsTo,
  lastEmailTo,
  login,
  MINUTE,
  PASSWORD,
  registerConfirmedUser,
  registerUser,
  travelBy,
  uniqueEmail,
} from './helpers'

const NEW_PASSWORD = 'new-password-1234'

describe('смена пароля по текущему', () => {
  it('меняет пароль и присылает письмо', async () => {
    const user = await registerConfirmedUser()
    const result = await changePasswordProcess.execute(
      new ChangePasswordOperation({ userId: user.id, currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    )
    expect(result).toEqual({ success: true })
    expect(lastEmailTo(user.email).subject).toBe('Пароль изменён')

    expect((await login(user.email, NEW_PASSWORD)).success).toBe(true)
    expect(await login(user.email, PASSWORD)).toEqual({
      success: false,
      error: LoginOperationErrorCode.INVALID_CREDENTIALS,
    })
  })

  it('неверный текущий пароль — INVALID_CURRENT_PASSWORD', async () => {
    const user = await registerConfirmedUser()
    const result = await changePasswordProcess.execute(
      new ChangePasswordOperation({ userId: user.id, currentPassword: 'nope-nope-nope', newPassword: NEW_PASSWORD }),
    )
    expect(result).toEqual({ success: false, error: ChangePasswordOperationErrorCode.INVALID_CURRENT_PASSWORD })
  })
})

describe('«не помню пароль»', () => {
  const forgot = (email: string) => forgotPasswordProcess.execute(new ForgotPasswordOperation({ email }))
  const reset = (email: string, code: string, newPassword = NEW_PASSWORD) =>
    forgotPasswordProcess.execute(new ResetPasswordOperation({ email, code, newPassword }))

  it('код из письма меняет пароль', async () => {
    const user = await registerConfirmedUser()
    expect(await forgot(user.email)).toEqual({ success: true })
    const letter = lastEmailTo(user.email)
    expect(letter.subject).toBe('Смена пароля')

    expect(await reset(user.email, codeFromEmail(letter))).toEqual({ success: true })
    expect((await login(user.email, NEW_PASSWORD)).success).toBe(true)
  })

  it('ответ всегда успех, но письмо получает только активный подтверждённый аккаунт', async () => {
    const stranger = uniqueEmail('nobody')
    expect(await forgot(stranger)).toEqual({ success: true })
    expect(emailsTo(stranger)).toHaveLength(0)

    const unconfirmed = await registerUser()
    const before = emailsTo(unconfirmed.email).length
    expect(await forgot(unconfirmed.email)).toEqual({ success: true })
    expect(emailsTo(unconfirmed.email)).toHaveLength(before)

    const blocked = await registerConfirmedUser()
    await blockDirectly(blocked.id)
    const blockedBefore = emailsTo(blocked.email).length
    expect(await forgot(blocked.email)).toEqual({ success: true })
    expect(emailsTo(blocked.email)).toHaveLength(blockedBefore)
  })

  it('повторный запрос выдаёт новый код и гасит прежний', async () => {
    const user = await registerConfirmedUser()
    await forgot(user.email)
    const first = codeFromEmail(lastEmailTo(user.email))
    await forgot(user.email)
    const second = codeFromEmail(lastEmailTo(user.email))
    expect(await codeRows(user.email, 'reset_password')).toHaveLength(1)

    expect(await reset(user.email, first)).toEqual({
      success: false,
      error: ResetPasswordOperationErrorCode.CODE_INVALID,
    })
    expect(await reset(user.email, second)).toEqual({ success: true })
  })

  it('истёкший код не работает; пять ошибок гасят код', async () => {
    const user = await registerConfirmedUser()
    await forgot(user.email)
    const code = codeFromEmail(lastEmailTo(user.email))
    travelBy(11 * MINUTE)
    expect(await reset(user.email, code)).toEqual({
      success: false,
      error: ResetPasswordOperationErrorCode.CODE_INVALID,
    })

    const other = await registerConfirmedUser()
    await forgot(other.email)
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await reset(other.email, '000000')).toEqual({
        success: false,
        error: ResetPasswordOperationErrorCode.CODE_INVALID,
      })
    }
    expect(await reset(other.email, '000000')).toEqual({
      success: false,
      error: ResetPasswordOperationErrorCode.TOO_MANY_ATTEMPTS,
    })
  })

  it('код подтверждения почты не годится для смены пароля', async () => {
    const user = await registerUser()
    const confirmationCode = codeFromEmail(lastEmailTo(user.email))
    expect(await reset(user.email, confirmationCode)).toEqual({
      success: false,
      error: ResetPasswordOperationErrorCode.CODE_INVALID,
    })
  })
})
