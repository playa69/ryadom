import type { NotificationSettingsDTO, PushSubscriptionDTO } from '../../../managers/notifications-manager'
export enum UpdateNotificationSettingsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_TIME = 'INVALID_TIME',
}

export type UpdateNotificationSettingsResult =
  | { success: true; settings: NotificationSettingsDTO; subscriptions: PushSubscriptionDTO[] }
  | { success: false; error: UpdateNotificationSettingsOperationErrorCode }
