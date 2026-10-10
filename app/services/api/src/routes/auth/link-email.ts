import { emailInputSchema, passwordInputSchema } from '@ryadom/core/config'
import {
  authenticationProcess,
  LinkEmailOperation,
  LinkEmailOperationErrorCode,
} from '@ryadom/core/processes/authentication'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { LinkEmailApiErrorCode, type LinkEmailApiResponse } from '@ryadom/contracts/api/auth/link-email'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * `POST /api/auth/email/link`: an anonymous account gets an address and a password. The core sends
 * the confirmation code; entering it is the existing `confirm-email`, which finds the account by the
 * address.
 */
const bodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
})

export function linkEmailRoutes(app: Hono<AppEnv>, { jwt, rateLimiter, analytics }: RouteDeps): void {
  app.post(
    ApiPath.LinkEmail,
    requireAuth(jwt),
    limitByIp(rateLimiter, 'link-email', RATE_LIMITS.emailCode.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const body = c.req.valid('json')
      const email = inputOrNull(emailInputSchema, body.email)
      if (email === null) return apiError(c, 422, 'Email is malformed')
      const password = inputOrNull(passwordInputSchema, body.password)
      if (password === null) return apiError(c, 422, 'Password length is out of range')

      // A second limit, per address: codes must not be sent in batches to the same mailbox.
      if (!(await rateLimiter.hit(`email:link:${email}`, RATE_LIMITS.emailCode.perEmail))) {
        return apiError(c, 429, 'Too many codes requested for this email')
      }

      const result = await authenticationProcess.execute(
        new LinkEmailOperation({ userId: authUser(c).userId, email, password }),
      )
      if (!result.success) {
        switch (result.error) {
          case LinkEmailOperationErrorCode.EMAIL_TAKEN:
            return apiRefused(c, LinkEmailApiErrorCode.EMAIL_TAKEN, 'Email is taken')
          case LinkEmailOperationErrorCode.ALREADY_HAS_EMAIL:
            return apiRefused(c, LinkEmailApiErrorCode.ALREADY_HAS_EMAIL, 'The account already has an email')
          case LinkEmailOperationErrorCode.DISPOSABLE_EMAIL:
            return apiRefused(c, LinkEmailApiErrorCode.DISPOSABLE_EMAIL, 'Disposable email domain')
          case LinkEmailOperationErrorCode.USER_NOT_FOUND:
            return apiRefused(c, LinkEmailApiErrorCode.USER_NOT_FOUND, 'User not found')
          case LinkEmailOperationErrorCode.USER_INACTIVE:
            return apiRefused(c, LinkEmailApiErrorCode.USER_INACTIVE, 'Account is inactive')
          default:
            return assertNever(result.error)
        }
      }

      const { userId } = authUser(c)
      analytics.identify(userId, { account_kind: 'email' })
      analytics.capture(userId, AnalyticsEvent.EmailLinked)

      const response: LinkEmailApiResponse = { email: result.email, emailConfirmationRequired: true }
      return apiOk(c, response)
    },
  )
}
