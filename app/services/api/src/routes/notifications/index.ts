import {
  CreateSubscriptionOperation,
  CreateSubscriptionOperationErrorCode,
  DeleteSubscriptionOperation,
  DeleteSubscriptionOperationErrorCode,
  GetNotificationSettingsOperation,
  GetNotificationSettingsOperationErrorCode,
  MarkReminderOpenedOperation,
  notificationsProcess,
  UpdateNotificationSettingsOperation,
  UpdateNotificationSettingsOperationErrorCode,
  type NotificationSettingsDTO,
  type PushSubscriptionDTO,
} from '@ryadom/core/processes/notifications'
import { vapidPublicKey } from '@ryadom/core/services/reminder-delivery-service'
import assertNever from 'assert-never'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { ApiPath } from '@ryadom/contracts/api/paths'
import {
  NotificationsApiErrorCode,
  PUSH_CHANNELS,
  type NotificationSettingsApiResponse,
  type SubscriptionApiResponse,
} from '@ryadom/contracts/api/notifications'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { RATE_LIMITS, type RateLimiter, type RateLimitRule } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'

/**
 * Reminders of the mood diary (`REQ-WELL-02`): the person's setting, the devices and chats the reminder
 * reaches, and the "opened from a reminder" signal that feeds the pause. Registered only with
 * `DIARY_ENABLED`.
 */

const settingsBody = z.object({
  moodReminder: z.object({ enabled: z.boolean().optional(), time: z.string().optional() }).optional(),
  offerAnswered: z.boolean().optional(),
})
const subscriptionBody = z.object({
  channel: z.enum(PUSH_CHANNELS),
  endpoint: z.string().max(2048).optional(),
  keys: z.object({ p256dh: z.string().max(512), auth: z.string().max(512) }).optional(),
  deviceLabel: z.string().max(80).optional(),
})
const openedBody = z.object({ deliveryId: z.number().int().positive() })

function perUser(limiter: RateLimiter, name: string, rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(await limiter.hit(`user:${name}:${authUser(c).userId}`, rule))) return apiError(c, 429, 'Too many requests')
    return next()
  }
}

function toSettings(settings: NotificationSettingsDTO, subs: PushSubscriptionDTO[]): NotificationSettingsApiResponse {
  return {
    moodReminder: { enabled: settings.moodReminderEnabled, time: settings.moodReminderTime, paused: settings.paused },
    offerAnswered: settings.offerAnswered,
    vapidPublicKey: vapidPublicKey(),
    subscriptions: subs.map((s) => ({
      id: s.id,
      channel: s.channel,
      deviceLabel: s.deviceLabel,
      createdAt: s.createdAt.toISOString(),
    })),
  }
}

type Refusal =
  | GetNotificationSettingsOperationErrorCode
  | UpdateNotificationSettingsOperationErrorCode
  | CreateSubscriptionOperationErrorCode
  | DeleteSubscriptionOperationErrorCode

function refuse(c: Context, error: Refusal): Response {
  switch (error) {
    case GetNotificationSettingsOperationErrorCode.USER_NOT_FOUND:
    case UpdateNotificationSettingsOperationErrorCode.USER_NOT_FOUND:
    case CreateSubscriptionOperationErrorCode.USER_NOT_FOUND:
      return apiError(c, 401, 'Unauthorised')
    case UpdateNotificationSettingsOperationErrorCode.INVALID_TIME:
      return apiError(c, 422, 'The time must be between 08:00 and 22:30, in steps of 30 minutes')
    case CreateSubscriptionOperationErrorCode.INVALID_SUBSCRIPTION:
      return apiRefused(c, NotificationsApiErrorCode.INVALID_SUBSCRIPTION, 'The subscription is not valid')
    case CreateSubscriptionOperationErrorCode.TELEGRAM_NOT_LINKED:
      return apiRefused(c, NotificationsApiErrorCode.INVALID_SUBSCRIPTION, 'The account is not linked to Telegram')
    case DeleteSubscriptionOperationErrorCode.SUBSCRIPTION_NOT_FOUND:
      return apiRefused(c, NotificationsApiErrorCode.SUBSCRIPTION_NOT_FOUND, 'No such subscription')
    default:
      return assertNever(error)
  }
}

export function notificationsRoutes(app: Hono<AppEnv>, { env, jwt, rateLimiter, sessions }: RouteDeps): void {
  if (!env.DIARY_ENABLED) return
  const read = perUser(rateLimiter, 'notifications-read', RATE_LIMITS.diaryRead.perUser)
  const write = perUser(rateLimiter, 'notifications-write', RATE_LIMITS.diaryWrite.perUser)

  app.get(ApiPath.NotificationSettings, requireAuth(jwt), requireActiveSession(sessions), read, async (c) => {
    const result = await notificationsProcess.execute(new GetNotificationSettingsOperation({ userId: authUser(c).userId }))
    if (!result.success) return refuse(c, result.error)
    return apiOk(c, toSettings(result.settings, result.subscriptions))
  })

  app.put(ApiPath.NotificationSettings, requireAuth(jwt), requireActiveSession(sessions), write, jsonBody(settingsBody), async (c) => {
    const body = c.req.valid('json')
    const result = await notificationsProcess.execute(
      new UpdateNotificationSettingsOperation({
        userId: authUser(c).userId,
        enabled: body.moodReminder?.enabled,
        time: body.moodReminder?.time,
        offerAnswered: body.offerAnswered,
      }),
    )
    if (!result.success) return refuse(c, result.error)
    return apiOk(c, toSettings(result.settings, result.subscriptions))
  })

  app.post(ApiPath.NotificationSubscriptions, requireAuth(jwt), requireActiveSession(sessions), write, jsonBody(subscriptionBody), async (c) => {
    const body = c.req.valid('json')
    const result = await notificationsProcess.execute(
      new CreateSubscriptionOperation({
        userId: authUser(c).userId,
        channel: body.channel,
        endpoint: body.endpoint,
        p256dh: body.keys?.p256dh,
        auth: body.keys?.auth,
        deviceLabel: body.deviceLabel,
      }),
    )
    if (!result.success) return refuse(c, result.error)
    const response: SubscriptionApiResponse = { id: result.id }
    return apiOk(c, response)
  })

  app.delete(`${ApiPath.NotificationSubscriptions}/:id`, requireAuth(jwt), requireActiveSession(sessions), write, async (c) => {
    const result = await notificationsProcess.execute(
      new DeleteSubscriptionOperation({ userId: authUser(c).userId, id: c.req.param('id') }),
    )
    if (!result.success) return refuse(c, result.error)
    return apiOk(c, null)
  })

  app.post(ApiPath.NotificationOpened, requireAuth(jwt), requireActiveSession(sessions), write, jsonBody(openedBody), async (c) => {
    await notificationsProcess.execute(
      new MarkReminderOpenedOperation({ userId: authUser(c).userId, deliveryId: c.req.valid('json').deliveryId }),
    )
    return apiOk(c, null)
  })
}
