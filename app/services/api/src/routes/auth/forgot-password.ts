import { ForgotPasswordOperation, forgotPasswordProcess } from '@ryadom/core/processes/forgot-password'
import type { Hono } from 'hono'
import { z } from 'zod'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk } from '../../lib/api-response'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { normalizeEmail } from '../../lib/rules'

/**
 * `POST /api/auth/forgot-password` — sends a password reset code by email. The response is always
 * the same: "the email was sent" must not be distinguishable from "no such address".
 */
const bodySchema = z.object({
  email: z.string().trim().min(1).max(254),
})

export function forgotPasswordRoutes(app: Hono<AppEnv>, { rateLimiter, logger }: RouteDeps): void {
  app.post(
    ApiPath.ForgotPassword,
    limitByIp(rateLimiter, 'forgot-password', RATE_LIMITS.emailCode.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const email = normalizeEmail(c.req.valid('json').email)
      if (!(await rateLimiter.hit(`email:forgot:${email}`, RATE_LIMITS.emailCode.perEmail))) {
        return apiError(c, 429, 'Too many codes requested for this email')
      }
      try {
        await forgotPasswordProcess.execute(new ForgotPasswordOperation({ email }))
      } catch (error) {
        logger.error({ err: error }, 'Не удалось отправить письмо для смены пароля')
      }
      return apiOk(c, null)
    },
  )
}
