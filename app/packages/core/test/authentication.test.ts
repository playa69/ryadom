/**
 * Registration, email confirmation by code, and sign-in.
 */
import { describe, expect, it } from 'vitest'
import {
  authenticationProcess,
  LoginOperationErrorCode,
  RegisterOperation,
  RegisterOperationErrorCode,
} from '../src/processes/authentication'
import { ConfirmEmailOperation, emailConfirmationProcess } from '../src/processes/email-confirmation'
import {
  blockDirectly,
  codeFromEmail,
  codeRows,
  confirmWithCode,
  emailsTo,
  lastEmailTo,
  login,
  PASSWORD,
  registerConfirmedUser,
  registerUser,
  uniqueEmail,
} from './helpers'

describe('регистрация', () => {
  it('создаёт аккаунт с неподтверждённой почтой, кодом и приветственным письмом', async () => {
    const email = uniqueEmail()
    const user = await registerUser({ email: `  ${email.toUpperCase()} `, name: '  Аня  ' })

    // The address is normalized and the name is trimmed.
    expect(user.email).toBe(email)
    expect(user.name).toBe('Аня')
    expect(user.isEmailConfirmed).toBe(false)

    const letter = lastEmailTo(email)
    expect(letter.subject).toBe('Добро пожаловать в «Рядом»')
    expect(await codeRows(email, 'confirm_email')).toHaveLength(1)
  })

  it('занятая (подтверждённая) почта — USER_ALREADY_EXISTS', async () => {
    const email = uniqueEmail()
    await registerConfirmedUser({ email })
    const again = await authenticationProcess.execute(
      new RegisterOperation({ email, password: PASSWORD, name: 'Боря' }),
    )
    expect(again).toEqual({ success: false, error: RegisterOperationErrorCode.USER_ALREADY_EXISTS })
  })

  it('заблокированная неподтверждённая почта остаётся занятой', async () => {
    const email = uniqueEmail()
    const user = await registerUser({ email })
    await blockDirectly(user.id)
    const again = await authenticationProcess.execute(
      new RegisterOperation({ email, password: PASSWORD, name: 'Боря' }),
    )
    expect(again).toEqual({ success: false, error: RegisterOperationErrorCode.USER_ALREADY_EXISTS })
  })

  it('неподтверждённую почту можно зарегистрировать заново: пароль и имя владельца, новый код', async () => {
    const email = uniqueEmail()
    // Someone parks the address with a password of their own and never confirms it.
    const parked = await registerUser({ email, password: 'attacker-password-1', name: 'Чужой' })
    const firstCode = codeFromEmail(lastEmailTo(email))

    const owner = await registerUser({ email, password: PASSWORD, name: 'Аня' })
    expect(owner.id).toBe(parked.id)
    expect(owner.name).toBe('Аня')
    expect(owner.isEmailConfirmed).toBe(false)

    // One account, one live code: the parked one is burned, the new one came in a letter.
    expect(await codeRows(email, 'confirm_email')).toHaveLength(1)
    const newCode = codeFromEmail(lastEmailTo(email))
    expect(emailsTo(email)).toHaveLength(2)
    if (newCode !== firstCode) {
      expect(
        await emailConfirmationProcess.execute(new ConfirmEmailOperation({ email, code: firstCode })),
      ).toMatchObject({ success: false })
    }

    await confirmWithCode(email)
    // Only the owner's password opens the account.
    expect((await login(email, 'attacker-password-1')).success).toBe(false)
    const result = await login(email)
    expect(result.success).toBe(true)
    if (result.success) expect(result.user.name).toBe('Аня')
  })

  it('одноразовая почта отклоняется', async () => {
    const result = await authenticationProcess.execute(
      new RegisterOperation({ email: 'someone@mailinator.com', password: PASSWORD, name: 'Аня' }),
    )
    expect(result).toEqual({ success: false, error: RegisterOperationErrorCode.DISPOSABLE_EMAIL })
  })
})

describe('вход', () => {
  it('до подтверждения почты войти нельзя, после — можно', async () => {
    const email = uniqueEmail()
    const user = await registerUser({ email })

    expect(await login(email)).toEqual({
      success: false,
      error: LoginOperationErrorCode.EMAIL_NOT_CONFIRMED,
    })

    await confirmWithCode(email)
    const result = await login(email)
    expect(result.success).toBe(true)
    if (result.success) expect(result.user.id).toBe(user.id)
  })

  it('неверный пароль и несуществующая почта — один и тот же отказ', async () => {
    const user = await registerConfirmedUser()
    expect(await login(user.email, 'wrong-password-123')).toEqual({
      success: false,
      error: LoginOperationErrorCode.INVALID_CREDENTIALS,
    })
    expect(await login(uniqueEmail('nobody'))).toEqual({
      success: false,
      error: LoginOperationErrorCode.INVALID_CREDENTIALS,
    })
  })

  it('заблокированный аккаунт — USER_INACTIVE, но только после верного пароля', async () => {
    const user = await registerConfirmedUser()
    await blockDirectly(user.id)
    // A wrong password outranks the block: otherwise the answer would reveal that the account exists.
    expect(await login(user.email, 'wrong-password-123')).toEqual({
      success: false,
      error: LoginOperationErrorCode.INVALID_CREDENTIALS,
    })
    expect(await login(user.email)).toEqual({ success: false, error: LoginOperationErrorCode.USER_INACTIVE })
  })
})
