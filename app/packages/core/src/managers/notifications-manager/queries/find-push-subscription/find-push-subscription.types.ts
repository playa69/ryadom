import type { NotificationSettingsDTO, PushSubscriptionDTO, ReminderCandidateDTO } from '../../shared/notifications.dto'
export type FindPushSubscriptionQueryResult = { success: true; subscription: PushSubscriptionDTO | null }
