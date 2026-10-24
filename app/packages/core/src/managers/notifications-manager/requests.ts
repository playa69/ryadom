import { RequestData } from 'mediatr-ts'
import type { PushChannel } from '@ryadom/db/schema'

export interface NotificationSettingsDTO {
  moodReminderEnabled: boolean
  /** `HH:mm`. */
  moodReminderTime: string
  paused: boolean
  offerAnswered: boolean
}

export interface PushSubscriptionDTO {
  id: string
  userId: string
  channel: PushChannel
  endpoint: string | null
  p256dh: string | null
  auth: string | null
  deviceLabel: string | null
  createdAt: Date
}

/** A person the reminder could reach right now, with what the scheduler needs to decide. */
export interface ReminderCandidateDTO {
  userId: string
  timezone: string
  /** `HH:mm`. */
  time: string
  streakResetAt: Date | null
  telegramId: number | null
}

export class GetNotificationSettingsQuery extends RequestData<{ success: true; settings: NotificationSettingsDTO }> {
  static readonly requestName = 'GetNotificationSettingsQuery'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

export class UpdateNotificationSettingsCommand extends RequestData<{ success: true; settings: NotificationSettingsDTO }> {
  static readonly requestName = 'UpdateNotificationSettingsCommand'
  constructor(
    public readonly data: {
      userId: string
      enabled?: boolean
      /** `HH:mm`. */
      time?: string
      offerAnswered?: boolean
    },
  ) {
    super()
  }
}

export class ListPushSubscriptionsQuery extends RequestData<{ success: true; subscriptions: PushSubscriptionDTO[] }> {
  static readonly requestName = 'ListPushSubscriptionsQuery'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

export class CreatePushSubscriptionCommand extends RequestData<{ success: true; subscription: PushSubscriptionDTO }> {
  static readonly requestName = 'CreatePushSubscriptionCommand'
  constructor(
    public readonly data: {
      userId: string
      channel: PushChannel
      endpoint?: string | null
      p256dh?: string | null
      auth?: string | null
      deviceLabel?: string | null
    },
  ) {
    super()
  }
}

/** `userId` is set when the person deletes their own subscription; the scheduler deletes any by id. */
export class DeletePushSubscriptionCommand extends RequestData<{ success: boolean }> {
  static readonly requestName = 'DeletePushSubscriptionCommand'
  constructor(public readonly data: { id: string; userId?: string }) {
    super()
  }
}

export class RecordPushResultCommand extends RequestData<{ success: true }> {
  static readonly requestName = 'RecordPushResultCommand'
  constructor(public readonly data: { id: string; ok: boolean }) {
    super()
  }
}

/** People with a server-side channel and an enabled, not paused reminder; the scheduler filters by local time. */
export class ListReminderCandidatesQuery extends RequestData<{ success: true; candidates: ReminderCandidateDTO[] }> {
  static readonly requestName = 'ListReminderCandidatesQuery'
  constructor(public readonly data: { limit: number; afterUserId?: string }) {
    super()
  }
}

/** Inserts the delivery of the day; `claimed: false` means another replica (or an earlier tick) already did. */
export class ClaimReminderDeliveryCommand extends RequestData<{ success: true; claimed: boolean; deliveryId: number | null }> {
  static readonly requestName = 'ClaimReminderDeliveryCommand'
  constructor(public readonly data: { userId: string; localDate: string; channel: string }) {
    super()
  }
}

export class MarkReminderDeliveryCommand extends RequestData<{ success: true }> {
  static readonly requestName = 'MarkReminderDeliveryCommand'
  constructor(public readonly data: { deliveryId: number; error?: string | null; channel?: string }) {
    super()
  }
}

/** The person opened the app from a reminder: `opened_at`, and a paused reminder wakes up. */
export class MarkReminderOpenedCommand extends RequestData<{ success: boolean }> {
  static readonly requestName = 'MarkReminderOpenedCommand'
  constructor(public readonly data: { userId: string; deliveryId: number }) {
    super()
  }
}

/** Unopened deliveries in a row, newest first, counted from `since`. */
export class CountUnopenedRemindersQuery extends RequestData<{ success: true; unopenedInRow: number }> {
  static readonly requestName = 'CountUnopenedRemindersQuery'
  constructor(public readonly data: { userId: string; since: Date | null; limit: number }) {
    super()
  }
}

export class PauseMoodReminderCommand extends RequestData<{ success: true }> {
  static readonly requestName = 'PauseMoodReminderCommand'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

/** True when today's note exists; the scheduler asks before it claims. */
export class HasMoodCheckinQuery extends RequestData<{ success: true; has: boolean }> {
  static readonly requestName = 'HasMoodCheckinQuery'
  constructor(public readonly data: { userId: string; localDate: string }) {
    super()
  }
}

export class CreateWidgetTokenCommand extends RequestData<{ success: true; token: string }> {
  static readonly requestName = 'CreateWidgetTokenCommand'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

export class RevokeWidgetTokensCommand extends RequestData<{ success: true }> {
  static readonly requestName = 'RevokeWidgetTokensCommand'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}

/** The user a widget token belongs to; null for an unknown or revoked token. */
export class FindWidgetTokenQuery extends RequestData<{ success: true; userId: string | null }> {
  static readonly requestName = 'FindWidgetTokenQuery'
  constructor(public readonly data: { token: string }) {
    super()
  }
}
