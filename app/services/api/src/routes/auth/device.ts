import { deviceIdInputSchema, deviceKeyInputSchema } from '@ryadom/core/config'
import {
  authenticationProcess,
  DeviceLoginOperation,
  DeviceLoginOperationErrorCode,
} from '@ryadom/core/processes/authentication'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { DeviceLoginApiResponse } from '@ryadom/contracts/api/auth/device'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { identifyUser } from '../../lib/analytics'
import { apiError, apiOk } from '../../lib/api-response'
import { clientDevice } from '../../lib/client-device'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { toAuthUser } from '../../lib/mappers'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * `POST /api/auth/device`: sign-in without an email. A device that has never been seen gets an
 * account made on the spot, so this route is also how accounts are created without a person typing
 * anything, which is why it has a limit of its own and a generous one: an address behind carrier NAT
 * is shared by many people installing the app, but a script making accounts is not one of them.
 */
const bodySchema = z.object({
  deviceId: z.string().min(1).max(200),
  deviceKey: z.string().min(1).max(500),
})

export function deviceRoutes(app: Hono<AppEnv>, { logger, rateLimiter, sessions, analytics }: RouteDeps): void {
  app.post(
    ApiPath.DeviceLogin,
    limitByIp(rateLimiter, 'device-login', RATE_LIMITS.deviceLogin.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const body = c.req.valid('json')
      // Our app never sends an id or a key of another shape, and a person cannot fix one: 400, not 422.
      const deviceId = inputOrNull(deviceIdInputSchema, body.deviceId)
      const deviceKey = inputOrNull(deviceKeyInputSchema, body.deviceKey)
      if (deviceId === null || deviceKey === null) return apiError(c, 400, 'Invalid device credentials')

      const result = await authenticationProcess.execute(new DeviceLoginOperation({ deviceId, deviceKey }))
      if (!result.success) {
        logger.info({ reason: result.error }, 'Вход по устройству отклонён')
        switch (result.error) {
          case DeviceLoginOperationErrorCode.DEVICE_KEY_INVALID:
          case DeviceLoginOperationErrorCode.USER_INACTIVE:
            return apiError(c, 401, 'Invalid device credentials')
          default:
            return assertNever(result.error)
        }
      }

      const response: DeviceLoginApiResponse = {
        user: toAuthUser(result.user),
        tokens: await sessions.start(result.user.id, clientDevice(c)),
        isNewAccount: result.isNewAccount,
      }
      identifyUser(analytics, result.user)
      if (result.isNewAccount) analytics.capture(result.user.id, AnalyticsEvent.AccountCreated, { kind: 'anonymous' })
      analytics.capture(result.user.id, AnalyticsEvent.LoggedIn, { method: 'device' })
      return apiOk(c, response)
    },
  )
}
