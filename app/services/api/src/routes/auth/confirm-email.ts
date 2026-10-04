import { codeInputSchema, emailInputSchema } from '@ryadom/core/config'
import {
  ConfirmEmailOperation,
  ConfirmEmailOperationErrorCode,
  emailConfirmationProcess,
} from '@ryadom/core/processes/email-confirmation'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * `POST /api/auth/confirm-email` — the code from the email confirms the address. The
 * per-IP limit is mandatory, otherwise a six-digit code can simply be guessed.
 */
const bodySchema = z.object({
  email: z.string().min(1),
  code: z.string().min(1),
})

export function confirmEmailRoutes(app: Hono<AppEnv>, { rateLimiter }: RouteDeps): void {
  app.post(
    ApiPath.ConfirmEmail,
    limitByIp(rateLimiter, 'confirm-email', RATE_LIMITS.attempt.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const body = c.req.valid('json')
      const email = inputOrNull(emailInputSchema, body.email)
      if (email === null) return apiError(c, 422, 'Email is malformed')
      const code = inputOrNull(codeInputSchema, body.code)
      if (code === null) return apiError(c, 422, 'Code must be 6 digits')

      const result = await emailConfirmationProcess.execute(new ConfirmEmailOperation({ email, code }))
      if (!result.success) {
        switch (result.error) {
          case ConfirmEmailOperationErrorCode.CODE_INVALID:
            return apiRefused(c, ConfirmEmailApiErrorCode.CODE_INVALID, 'Code is invalid or expired')
          case ConfirmEmailOperationErrorCode.TOO_MANY_ATTEMPTS:
            return apiRefused(c, ConfirmEmailApiErrorCode.TOO_MANY_ATTEMPTS, 'Too many attempts')
          case ConfirmEmailOperationErrorCode.EMAIL_ALREADY_CONFIRMED:
            return apiRefused(c, ConfirmEmailApiErrorCode.EMAIL_ALREADY_CONFIRMED, 'Email already confirmed')
          default:
            return assertNever(result.error)
        }
      }
      return apiOk(c, null)
    },
  )
}
