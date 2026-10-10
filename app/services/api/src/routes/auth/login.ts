import {
  authenticationProcess,
  LoginOperation,
  LoginOperationErrorCode,
} from '@ryadom/core/processes/authentication'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { LoginApiResponse } from '@ryadom/contracts/api/auth/shared'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { identifyUser } from '../../lib/analytics'
import { apiError, apiOk } from '../../lib/api-response'
import { clientDevice } from '../../lib/client-device'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { toAuthUser } from '../../lib/mappers'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { normalizeEmail } from '../../lib/rules'

/**
 * `POST /api/auth/login`. Every failure gets the same answer: a bare 401. The reason must not be
 * named, because "confirm your email" confirms that the address is registered. The real reason goes
 * to the log, and the login screen lists all the cases at once under "Can't sign in?".
 */
const bodySchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(1024),
})

export function loginRoutes(app: Hono<AppEnv>, { logger, rateLimiter, sessions, analytics }: RouteDeps): void {
  app.post(
    ApiPath.Login,
    limitByIp(rateLimiter, 'login', RATE_LIMITS.attempt.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const body = c.req.valid('json')
      const result = await authenticationProcess.execute(
        new LoginOperation({ email: normalizeEmail(body.email), password: body.password }),
      )

      if (!result.success) {
        // All failures share one answer, but they are listed by name: a new core failure has to be
        // seen here so that someone decides whether it stays indistinguishable.
        logger.info({ reason: result.error }, 'Вход отклонён')
        switch (result.error) {
          case LoginOperationErrorCode.INVALID_CREDENTIALS:
          case LoginOperationErrorCode.USER_INACTIVE:
          case LoginOperationErrorCode.EMAIL_NOT_CONFIRMED:
            return apiError(c, 401, 'Invalid email or password')
          default:
            return assertNever(result.error)
        }
      }

      const response: LoginApiResponse = {
        user: toAuthUser(result.user),
        tokens: await sessions.start(result.user.id, clientDevice(c)),
      }
      identifyUser(analytics, result.user)
      analytics.capture(result.user.id, AnalyticsEvent.LoggedIn, { method: 'password' })
      return apiOk(c, response)
    },
  )
}
