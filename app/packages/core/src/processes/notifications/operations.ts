import { RequestData } from 'mediatr-ts'
import type { PushChannel } from '@ryadom/db/schema'
import type { NotificationSettingsDTO, PushSubscriptionDTO } from '../../managers/notifications-manager'

export enum NotificationsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The time is not one of 08:00…22:30 in steps of 30 minutes. */
  INVALID_TIME = 'INVALID_TIME',
  /** The endpoint or the keys of a Web Push subscription are missing or not valid. */
  INVALID_SUBSCRIPTION = 'INVALID_SUBSCRIPTION',
  /** A Telegram subscription needs an account that signed in from the Mini App. */
  TELEGRAM_NOT_LINKED = 'TELEGRAM_NOT_LINKED',
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
}

type Failure = { success: false; error: NotificationsOperationErrorCode }

export class GetNotificationSettingsOperation extends RequestData<
  { success: true; settings: NotificationSettingsDTO; subscriptions: PushSubscriptionDTO[] } | Failure
> {
  static readonly requestName = 'GetNotificationSettingsOperation'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

export class UpdateNotificationSettingsOperation extends RequestData<
  { success: true; settings: NotificationSettingsDTO; subscriptions: PushSubscriptionDTO[] } | Failure
> {
  static readonly requestName = 'UpdateNotificationSettingsOperation'
  constructor(public readonly data: { userId: string; enabled?: boolean; time?: string; offerAnswered?: boolean }) {
    super()
  }
}

export class CreateSubscriptionOperation extends RequestData<{ success: true; id: string } | Failure> {
  static readonly requestName = 'CreateSubscriptionOperation'
  constructor(
    public readonly data: {
      userId: string
      channel: PushChannel
      endpoint?: string
      p256dh?: string
      auth?: string
      deviceLabel?: string
    },
  ) {
    super()
  }
}

export class DeleteSubscriptionOperation extends RequestData<{ success: true } | Failure> {
  static readonly requestName = 'DeleteSubscriptionOperation'
  constructor(public readonly data: { userId: string; id: string }) {
    super()
  }
}

export class MarkReminderOpenedOperation extends RequestData<{ success: true }> {
  static readonly requestName = 'MarkReminderOpenedOperation'
  constructor(public readonly data: { userId: string; deliveryId: number }) {
    super()
  }
}

export class CreateWidgetTokenOperation extends RequestData<{ success: true; token: string } | Failure> {
  static readonly requestName = 'CreateWidgetTokenOperation'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

export class RevokeWidgetTokenOperation extends RequestData<{ success: true }> {
  static readonly requestName = 'RevokeWidgetTokenOperation'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

/** The user a widget token stands for; null for an unknown, revoked or blocked one. */
export class ResolveWidgetTokenOperation extends RequestData<{ success: true; userId: string | null }> {
  static readonly requestName = 'ResolveWidgetTokenOperation'
  constructor(public readonly data: { token: string }) {
    super()
  }
}

export interface ReminderTickResult {
  success: true
  /** Reminders handed to a channel in this tick. */
  sent: number
  /** People whose reminder was paused in this tick (seven unopened in a row). */
  paused: number
}

/**
 * One minute of the scheduler (design D9). For everyone with a server-side channel whose local clock
 * is inside the window of today's reminder, without a note today and not paused, the tick inserts the
 * delivery of the day (the unique key lets one replica win) and only the winner sends.
 */
export class RunReminderTickOperation extends RequestData<ReminderTickResult> {
  static readonly requestName = 'RunReminderTickOperation'
  constructor(public readonly data: { now?: Date; batch?: number } = {}) {
    super()
  }
}
