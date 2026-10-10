/**
 * Email confirmation by code, and resending it.
 */
import { describe, expect, it } from 'vitest'
import {
  ConfirmEmailOperation,
  ConfirmEmailOperationErrorCode,
  emailConfirmationProcess,
  ResendConfirmationOperation,
} from '../src/processes/email-confirmation'
import {
  codeFromEmail,
  codeRows,
  confirmWithCode,
  emailsTo,
  getUserRow,
  lastEmailTo,
  MINUTE,
  registerUser,
  travelBy,
  uniqueEmail,
} from './helpers'

const confirm = (email: string, code: string) =>
  emailConfirmationProcess.execute(new ConfirmEmailOperation({ email, code }))

describe('подтверждение почты', () => {
  it('верный код подтверждает почту и гасится', async () => {
    const user = await registerUser()
    await confirmWithCode(user.email)

    expect((await getUserRow(user.id))?.isEmailConfirmed).toBe(true)
    const [code] = await codeRows(user.email, 'confirm_email')
    expect(code?.usedAt).not.toBeNull()
  })

  it('повторное подтверждение тем же кодом — CODE_INVALID', async () => {
    const user = await registerUser()
    const code = codeFromEmail(lastEmailTo(user.email))
    // The result names the account, so a caller that wants to report the event need not look it up.
    expect(await confirm(user.email, code)).toEqual({ success: true, userId: user.id })
    expect(await confirm(user.email, code)).toEqual({
      success: false,
      error: ConfirmEmailOperationErrorCode.CODE_INVALID,
    })
  })

  it('пять неверных попыток гасят код', async () => {
    const user = await registerUser()
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await confirm(user.email, '000000')).toEqual({
        success: false,
        error: ConfirmEmailOperationErrorCode.CODE_INVALID,
      })
    }
    expect(await confirm(user.email, '000000')).toEqual({
      success: false,
      error: ConfirmEmailOperationErrorCode.TOO_MANY_ATTEMPTS,
    })
    // The code is burned: even the real one no longer works.
    const real = codeFromEmail(lastEmailTo(user.email))
    expect(await confirm(user.email, real)).toEqual({
      success: false,
      error: ConfirmEmailOperationErrorCode.CODE_INVALID,
    })
  })

  it('код живёт десять минут', async () => {
    const user = await registerUser()
    const code = codeFromEmail(lastEmailTo(user.email))
    travelBy(11 * MINUTE)
    expect(await confirm(user.email, code)).toEqual({
      success: false,
      error: ConfirmEmailOperationErrorCode.CODE_INVALID,
    })
  })
})

describe('повторная отправка кода', () => {
  const resend = (email: string) =>
    emailConfirmationProcess.execute(new ResendConfirmationOperation({ email }))

  it('новый код заменяет прежний, письмо уходит', async () => {
    const user = await registerUser()
    const first = codeFromEmail(lastEmailTo(user.email))

    expect(await resend(user.email)).toEqual({ success: true })
    const letter = lastEmailTo(user.email)
    expect(letter.subject).toBe('Подтверди почту')
    const second = codeFromEmail(letter)
    expect(await codeRows(user.email, 'confirm_email')).toHaveLength(1)

    expect(await confirm(user.email, first)).toEqual({
      success: false,
      error: ConfirmEmailOperationErrorCode.CODE_INVALID,
    })
    expect((await confirm(user.email, second)).success).toBe(true)
  })

  it('ответ одинаковый, но письма получает только тот, кому положено', async () => {
    const stranger = uniqueEmail('nobody')
    expect(await resend(stranger)).toEqual({ success: true })
    expect(emailsTo(stranger)).toHaveLength(0)

    const user = await registerUser()
    await confirmWithCode(user.email)
    const before = emailsTo(user.email).length
    expect(await resend(user.email)).toEqual({ success: true })
    // The address is already confirmed, so there is no second letter.
    expect(emailsTo(user.email)).toHaveLength(before)
  })
})
