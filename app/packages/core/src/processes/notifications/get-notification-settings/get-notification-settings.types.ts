import type { NotificationSettingsDTO, PushSubscriptionDTO } from '../../../managers/notifications-manager'
export enum GetNotificationSettingsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetNotificationSettingsResult =
  | { success: true; settings: NotificationSettingsDTO; subscriptions: PushSubscriptionDTO[] }
  | { success: false; error: GetNotificationSettingsOperationErrorCode }
