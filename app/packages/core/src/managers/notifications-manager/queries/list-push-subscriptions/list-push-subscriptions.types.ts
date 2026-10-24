import type { NotificationSettingsDTO, PushSubscriptionDTO, ReminderCandidateDTO } from '../../shared/notifications.dto'
export type ListPushSubscriptionsQueryResult = { success: true; subscriptions: PushSubscriptionDTO[] }
