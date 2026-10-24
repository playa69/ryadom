/**
 * Reminders (`REQ-WELL-02`). One mood reminder a day at the person's local time, to the channels
 * they have: Web Push, the Telegram bot, local notifications of the native build.
 */

export const PUSH_CHANNELS = ['web_push', 'telegram', 'native_local'] as const
export type PushChannel = (typeof PUSH_CHANNELS)[number]

/** Default local time of the reminder. */
export const MOOD_REMINDER_DEFAULT_TIME = '20:00'
/** Unopened reminders in a row after which they pause until the person opens the app. */
export const MOOD_REMINDER_PAUSE_AFTER = 7

export enum NotificationsApiErrorCode {
  /** The push endpoint or keys are not valid. */
  INVALID_SUBSCRIPTION = 'INVALID_SUBSCRIPTION',
  /** The subscription belongs to another account or is gone. */
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
  /** Web Push is not set up on the server (no VAPID keys). */
  PUSH_UNAVAILABLE = 'PUSH_UNAVAILABLE',
}

/** `GET /api/notifications/settings`. */
export interface NotificationSettingsApiResponse {
  moodReminder: { enabled: boolean; time: string; paused: boolean }
  offerAnswered: boolean
  /** The public VAPID key a browser subscribes with; null when Web Push is off. */
  vapidPublicKey: string | null
  subscriptions: { id: string; channel: PushChannel; deviceLabel: string | null; createdAt: string }[]
}

/** `PUT /api/notifications/settings`: only the fields sent change. */
export interface UpdateNotificationSettingsApiRequest {
  moodReminder?: { enabled?: boolean; /** `HH:mm`. */ time?: string }
  offerAnswered?: boolean
}

/** `POST /api/notifications/subscriptions`. */
export interface CreateSubscriptionApiRequest {
  channel: PushChannel
  /** Web Push only. */
  endpoint?: string
  keys?: { p256dh: string; auth: string }
  deviceLabel?: string
}

export interface SubscriptionApiResponse {
  id: string
}

/** `POST /api/notifications/opened`: the person opened the app from a reminder. */
export interface NotificationOpenedApiRequest {
  deliveryId: number
}
