import type { PushChannel, PushSubscriptionRow } from '@ryadom/db/schema'

/** What the reminder is when the person has changed nothing: on, at 20:00 local time. */
export const DEFAULT_REMINDER_TIME = '20:00'
/** The `kind` of the one reminder there is; the delivery key is (person, kind, local day). */
export const MOOD_DELIVERY_KIND = 'mood'

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

export const toHHmm = (time: string): string => time.slice(0, 5)

export function toPushSubscriptionDTO(row: PushSubscriptionRow): PushSubscriptionDTO {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt,
  }
}
