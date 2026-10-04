import { emailInputSchema, nameInputSchema, passwordInputSchema } from '@ryadom/core/config'
import {
  authenticationProcess,
  RegisterOperation,
  RegisterOperationErrorCode,
} from '@ryadom/core/processes/authentication'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { RegisterApiErrorCode, type RegisterApiResponse } from '@ryadom/contracts/api/auth/register'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { clientIp, limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * `POST /api/auth/register`. It issues no session: sign-in opens only after the email
 * is confirmed with a code, otherwise someone who registered would use the app unconfirmed and then
 * be unable to sign in again after signing out. The core sends the email with the code.
 */
const bodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  name: z.string(),
})

export function registerRoutes(app: Hono<AppEnv>, { rateLimiter }: RouteDeps): void {
  app.post(
    ApiPath.Register,
    limitByIp(rateLimiter, 'register', RATE_LIMITS.emailCode.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const body = c.req.valid('json')
      // The core input rules are checked here: a violation is something the person can fix, so 422.
      const email = inputOrNull(emailInputSchema, body.email)
      if (email === null) return apiError(c, 422, 'Email is malformed')
      const password = inputOrNull(passwordInputSchema, body.password)
      if (password === null) return apiError(c, 422, 'Password length is out of range')
      const name = inputOrNull(nameInputSchema, body.name)
      if (name === null) return apiError(c, 422, 'Name length is out of range')

      // A second limit, per address: codes must not be sent in batches to the same mailbox.
      if (!rateLimiter.hit(`email:register:${email}`, RATE_LIMITS.emailCode.perEmail)) {
        return apiError(c, 429, 'Too many codes requested for this email')
      }

      const result = await authenticationProcess.execute(new RegisterOperation({ email, password, name }))
      if (!result.success) {
        switch (result.error) {
          case RegisterOperationErrorCode.USER_ALREADY_EXISTS:
            return apiRefused(c, RegisterApiErrorCode.USER_ALREADY_EXISTS, 'User already exists')
          case RegisterOperationErrorCode.DISPOSABLE_EMAIL:
            return apiRefused(c, RegisterApiErrorCode.DISPOSABLE_EMAIL, 'Disposable email domain')
          default:
            return assertNever(result.error)
        }
      }

      const response: RegisterApiResponse = { email: result.user.email, emailConfirmationRequired: true }
      return apiOk(c, response)
    },
  )
}
