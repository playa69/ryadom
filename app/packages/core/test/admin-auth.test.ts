/**
 * Admin sign-in: the allowlist of addresses and the code sent by email.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  adminAuthenticationProcess,
  ConfirmAdminCodeOperation,
  ConfirmAdminCodeOperationErrorCode,
  RequestAdminCodeOperation,
} from '../src/processes/admin-authentication'
import { resetEnvCache } from '../src/config'
import { ADMIN_EMAIL, codeFromEmail, codeRows, emailsTo, lastEmailTo, MINUTE, travelBy, uniqueEmail } from './helpers'

const requestCode = (email: string) =>
  adminAuthenticationProcess.execute(new RequestAdminCodeOperation({ email }))
const confirmCode = (email: string, code: string) =>
  adminAuthenticationProcess.execute(new ConfirmAdminCodeOperation({ email, code }))

describe('запрос кода', () => {
  it('код уходит почте из списка', async () => {
    expect(await requestCode(ADMIN_EMAIL)).toEqual({ success: true })
    expect(lastEmailTo(ADMIN_EMAIL).subject).toBe('Код входа в админку')
    expect(await codeRows(ADMIN_EMAIL, 'admin_sign_in')).toHaveLength(1)
  })

  it('ответ тот же, но письма чужой почте нет', async () => {
    const stranger = uniqueEmail('stranger')
    expect(await requestCode(stranger)).toEqual({ success: true })
    expect(emailsTo(stranger)).toHaveLength(0)
    expect(await codeRows(stranger)).toHaveLength(0)
  })

  it('регистр и пробелы не мешают', async () => {
    expect(await requestCode(`  ${ADMIN_EMAIL.toUpperCase()} `)).toEqual({ success: true })
    expect(emailsTo(ADMIN_EMAIL)).toHaveLength(1)
  })
})

describe('подтверждение кода', () => {
  it('верный код пускает и гасится', async () => {
    await requestCode(ADMIN_EMAIL)
    const code = codeFromEmail(lastEmailTo(ADMIN_EMAIL))
    expect(await confirmCode(ADMIN_EMAIL, code)).toEqual({ success: true, email: ADMIN_EMAIL })
    expect(await confirmCode(ADMIN_EMAIL, code)).toEqual({
      success: false,
      error: ConfirmAdminCodeOperationErrorCode.CODE_INVALID,
    })
  })

  it('пять ошибок гасят код, истёкший код не работает', async () => {
    await requestCode(ADMIN_EMAIL)
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await confirmCode(ADMIN_EMAIL, '000000')).toEqual({
        success: false,
        error: ConfirmAdminCodeOperationErrorCode.CODE_INVALID,
      })
    }
    expect(await confirmCode(ADMIN_EMAIL, '000000')).toEqual({
      success: false,
      error: ConfirmAdminCodeOperationErrorCode.TOO_MANY_ATTEMPTS,
    })

    await requestCode(ADMIN_EMAIL)
    const code = codeFromEmail(lastEmailTo(ADMIN_EMAIL))
    travelBy(11 * MINUTE)
    expect(await confirmCode(ADMIN_EMAIL, code)).toEqual({
      success: false,
      error: ConfirmAdminCodeOperationErrorCode.CODE_INVALID,
    })
  })

  it('почту убрали из списка после выдачи кода — NOT_ADMIN', async () => {
    await requestCode(ADMIN_EMAIL)
    const code = codeFromEmail(lastEmailTo(ADMIN_EMAIL))

    vi.stubEnv('ADMIN_EMAILS', 'someone-else@example.com')
    resetEnvCache()

    expect(await confirmCode(ADMIN_EMAIL, code)).toEqual({
      success: false,
      error: ConfirmAdminCodeOperationErrorCode.NOT_ADMIN,
    })
  })

  it('без списка админов войти нельзя никому', async () => {
    vi.stubEnv('ADMIN_EMAILS', '')
    resetEnvCache()
    expect(await requestCode(ADMIN_EMAIL)).toEqual({ success: true })
    expect(emailsTo(ADMIN_EMAIL)).toHaveLength(0)
  })
})
