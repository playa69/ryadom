'use server'

import { adminAuthenticationProcess } from '@ryadom/core/processes/admin-authentication'
import {
  ConfirmAdminCodeOperation,
  ConfirmAdminCodeOperationErrorCode,
  RequestAdminCodeOperation,
} from '@ryadom/core/processes/admin-authentication'
import { codeInputSchema, emailInputSchema } from '@ryadom/core/config'
import { createLogger } from '@ryadom/core/shared'
import assertNever from 'assert-never'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ADMIN_LIMITS, clientIp, hitLimit } from '@/lib/rate-limit'
import { adminSessionCookieOptions, ADMIN_COOKIE_NAME, createAdminSession } from '@/lib/session'
import { INITIAL_LOGIN_STATE, type LoginFormState } from './shared'

const logger = createLogger('admin.login')

const RATE_LIMITED = 'Слишком много попыток. Подождите немного и попробуйте снова.'

/**
 * Step one. The answer is identical for every address: an outsider must not be able to learn
 * who is on the allow-list by watching the response. The code is only sent to an address in
 * ADMIN_EMAILS, and that check lives in the core operation.
 */
export async function requestCode(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const raw = String(formData.get('email') ?? '')
  const parsed = emailInputSchema.safeParse(raw)
  if (!parsed.success) return { ...INITIAL_LOGIN_STATE, email: raw, error: 'Проверьте адрес почты.' }
  const email = parsed.data

  const ip = await clientIp()
  if (!hitLimit(`code:ip:${ip}`, ADMIN_LIMITS.codeByIp) || !hitLimit(`code:email:${email}`, ADMIN_LIMITS.codeByEmail)) {
    logger.warn('Admin code request rate limited', { ip })
    return { ...INITIAL_LOGIN_STATE, email, error: RATE_LIMITED }
  }

  await adminAuthenticationProcess.execute(new RequestAdminCodeOperation({ email }))
  return { step: 'code', email, error: null }
}

/** Step two. On success the session cookie is set and the browser goes to the users list. */
export async function confirmCode(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const email = String(formData.get('email') ?? '')
  const codeParsed = codeInputSchema.safeParse(String(formData.get('code') ?? '').trim())
  if (!codeParsed.success) return { step: 'code', email, error: 'Код состоит из шести цифр.' }

  const ip = await clientIp()
  if (!hitLimit(`confirm:ip:${ip}`, ADMIN_LIMITS.confirmByIp)) {
    return { step: 'code', email, error: RATE_LIMITED }
  }

  const result = await adminAuthenticationProcess.execute(
    new ConfirmAdminCodeOperation({ email, code: codeParsed.data }),
  )

  if (!result.success) {
    switch (result.error) {
      case ConfirmAdminCodeOperationErrorCode.CODE_INVALID:
        return { step: 'code', email, error: 'Код неверный или истёк. Запросите новый.' }
      case ConfirmAdminCodeOperationErrorCode.TOO_MANY_ATTEMPTS:
        return { step: 'email', email, error: 'Слишком много неверных попыток. Запросите новый код.' }
      case ConfirmAdminCodeOperationErrorCode.NOT_ADMIN:
        // The address was removed from the allow-list after the code was issued.
        return { step: 'email', email: '', error: 'Доступ закрыт.' }
      default:
        return assertNever(result.error)
    }
  }

  const token = await createAdminSession(result.email)
  ;(await cookies()).set(ADMIN_COOKIE_NAME, token, adminSessionCookieOptions())
  logger.info('Admin signed in', { email: result.email })
  redirect('/users')
}
