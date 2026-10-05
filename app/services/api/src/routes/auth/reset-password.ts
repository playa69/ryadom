import { codeInputSchema, emailInputSchema, passwordInputSchema } from '@ryadom/core/config'
import {
  forgotPasswordProcess,
  ResetPasswordOperation,
  ResetPasswordOperationErrorCode,
} from '@ryadom/core/processes/forgot-password'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { ResetPasswordApiErrorCode } from '@ryadom/contracts/api/auth/reset-password'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * `POST /api/auth/reset-password` — the code and the new password in one form. After a
 * success the app signs in with the new password by itself.
 */
const bodySchema = z.object({
  email: z.string().min(1),
  code: z.string().min(1),
  newPassword: z.string().min(1),
})

export function resetPasswordRoutes(app: Hono<AppEnv>, { rateLimiter }: RouteDeps): void {
  app.post(
    ApiPath.ResetPassword,
    limitByIp(rateLimiter, 'reset-password', RATE_LIMITS.attempt.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const body = c.req.valid('json')
      const email = inputOrNull(emailInputSchema, body.email)
      if (email === null) return apiError(c, 422, 'Email is malformed')
      const code = inputOrNull(codeInputSchema, body.code)
      if (code === null) return apiError(c, 422, 'Code must be 6 digits')
      const newPassword = inputOrNull(passwordInputSchema, body.newPassword)
      if (newPassword === null) return apiError(c, 422, 'Password length is out of range')

      const result = await forgotPasswordProcess.execute(new ResetPasswordOperation({ email, code, newPassword }))
      if (!result.success) {
        switch (result.error) {
          case ResetPasswordOperationErrorCode.CODE_INVALID:
            return apiRefused(c, ResetPasswordApiErrorCode.CODE_INVALID, 'Code is invalid or expired')
          case ResetPasswordOperationErrorCode.TOO_MANY_ATTEMPTS:
            return apiRefused(c, ResetPasswordApiErrorCode.TOO_MANY_ATTEMPTS, 'Too many attempts')
          case ResetPasswordOperationErrorCode.USER_INACTIVE:
            return apiRefused(c, ResetPasswordApiErrorCode.USER_INACTIVE, 'Account is inactive')
          default:
            return assertNever(result.error)
        }
      }
      return apiOk(c, null)
    },
  )
}
