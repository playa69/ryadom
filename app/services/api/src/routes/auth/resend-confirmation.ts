import { emailConfirmationProcess, ResendConfirmationOperation } from '@ryadom/core/processes/email-confirmation'
import type { Hono } from 'hono'
import { z } from 'zod'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk } from '../../lib/api-response'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { normalizeEmail } from '../../lib/rules'

/**
 * `POST /api/auth/resend-confirmation` — another confirmation code. Unauthenticated, because
 * signing in before confirmation is impossible, and with a uniform response that does not reveal
 * whether the account exists.
 */
const bodySchema = z.object({
  email: z.string().trim().min(1).max(254),
})

export function resendConfirmationRoutes(app: Hono<AppEnv>, { rateLimiter, logger }: RouteDeps): void {
  app.post(
    ApiPath.ResendConfirmation,
    limitByIp(rateLimiter, 'resend-confirmation', RATE_LIMITS.emailCode.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const email = normalizeEmail(c.req.valid('json').email)
      if (!(await rateLimiter.hit(`email:resend:${email}`, RATE_LIMITS.emailCode.perEmail))) {
        return apiError(c, 429, 'Too many codes requested for this email')
      }
      try {
        await emailConfirmationProcess.execute(new ResendConfirmationOperation({ email }))
      } catch (error) {
        // A send failure is not surfaced: otherwise the timing and text of the response would tell
        // an existing account apart from a non-existent one.
        logger.error({ err: error }, 'Не удалось отправить письмо с кодом подтверждения')
      }
      return apiOk(c, null)
    },
  )
}
