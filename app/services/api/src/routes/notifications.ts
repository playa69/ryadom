import {
  PUSH_CHANNELS,
  SubscribePushDeviceOperation,
  SubscribePushDeviceOperationErrorCode,
  UnsubscribePushDeviceOperation,
  UnsubscribePushDeviceOperationErrorCode,
  notificationsProcess,
} from '@ryadom/core/processes/notifications'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import {
  PushSubscriptionApiErrorCode,
  type PushSubscriptionApiResponse,
} from '@ryadom/contracts/api/notifications'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../lib/context'
import { RATE_LIMITS } from '../lib/rate-limit'
import { jsonBody } from '../lib/request'

/**
 * Devices subscribed to notifications (`add-push-notifications`, «Подписка устройства»):
 *
 * - `POST /api/notifications/subscriptions`: the device with notifications switched on gives its push token. Done on
 *   every start and sign-in, so it is idempotent by the token, and the subscription moves to this session;
 * - `DELETE /api/notifications/subscriptions/:id`: switched off, or signing out.
 *
 * The push token is the device's address at the push service and is never logged (the request body is not logged).
 */
const subscribeBody = z.object({
  channel: z.enum(PUSH_CHANNELS),
  token: z.string().min(1).max(4096),
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  appId: z
    .string()
    .max(255)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
})

export function notificationsRoutes(app: Hono<AppEnv>, { jwt, sessions, rateLimiter }: RouteDeps): void {
  const requireOpenSession = requireActiveSession(sessions)

  app.post(
    ApiPath.NotificationSubscriptions,
    requireAuth(jwt),
    requireOpenSession,
    jsonBody(subscribeBody),
    async (c) => {
      const { userId, sessionId } = authUser(c)
      // A subscription lives as long as its session: a token without one would get notifications after signing out.
      if (!sessionId) return apiError(c, 401, 'A session is required')
      if (!(await rateLimiter.hit(`user:push-subscribe:${userId}`, RATE_LIMITS.pushSubscribe.perUser))) {
        return apiError(c, 429, 'Too many subscriptions')
      }
      const result = await notificationsProcess.execute(
        new SubscribePushDeviceOperation({ userId, sessionId, ...c.req.valid('json') }),
      )
      if (!result.success) {
        switch (result.error) {
          case SubscribePushDeviceOperationErrorCode.USER_NOT_FOUND:
            return apiRefused(c, PushSubscriptionApiErrorCode.USER_NOT_FOUND, 'User not found')
          default:
            return assertNever(result.error)
        }
      }
      const response: PushSubscriptionApiResponse = { subscriptionId: result.subscriptionId }
      return apiOk(c, response)
    },
  )

  app.delete(
    `${ApiPath.NotificationSubscriptions}/:subscriptionId`,
    requireAuth(jwt),
    requireOpenSession,
    async (c) => {
      const result = await notificationsProcess.execute(
        new UnsubscribePushDeviceOperation({
          userId: authUser(c).userId,
          subscriptionId: c.req.param('subscriptionId'),
        }),
      )
      if (!result.success) {
        switch (result.error) {
          case UnsubscribePushDeviceOperationErrorCode.SUBSCRIPTION_NOT_FOUND:
            return apiRefused(c, PushSubscriptionApiErrorCode.SUBSCRIPTION_NOT_FOUND, 'No such subscription')
          default:
            return assertNever(result.error)
        }
      }
      return apiOk(c, null)
    },
  )
}
