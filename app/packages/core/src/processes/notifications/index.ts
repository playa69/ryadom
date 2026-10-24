// 1. Handler imports
import './get-notification-settings/get-notification-settings.handler'
import './update-notification-settings/update-notification-settings.handler'
import './create-subscription/create-subscription.handler'
import './delete-subscription/delete-subscription.handler'
import './mark-reminder-opened/mark-reminder-opened.handler'
import './create-widget-token/create-widget-token.handler'
import './revoke-widget-token/revoke-widget-token.handler'
import './resolve-widget-token/resolve-widget-token.handler'
import './run-reminder-tick/run-reminder-tick.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { GetNotificationSettingsOperation } from './get-notification-settings/get-notification-settings.operation'
export type { GetNotificationSettingsOperationData } from './get-notification-settings/get-notification-settings.operation'
export { UpdateNotificationSettingsOperation } from './update-notification-settings/update-notification-settings.operation'
export type { UpdateNotificationSettingsOperationData } from './update-notification-settings/update-notification-settings.operation'
export { CreateSubscriptionOperation } from './create-subscription/create-subscription.operation'
export type { CreateSubscriptionOperationData } from './create-subscription/create-subscription.operation'
export { DeleteSubscriptionOperation } from './delete-subscription/delete-subscription.operation'
export type { DeleteSubscriptionOperationData } from './delete-subscription/delete-subscription.operation'
export { MarkReminderOpenedOperation } from './mark-reminder-opened/mark-reminder-opened.operation'
export type { MarkReminderOpenedOperationData } from './mark-reminder-opened/mark-reminder-opened.operation'
export { CreateWidgetTokenOperation } from './create-widget-token/create-widget-token.operation'
export type { CreateWidgetTokenOperationData } from './create-widget-token/create-widget-token.operation'
export { RevokeWidgetTokenOperation } from './revoke-widget-token/revoke-widget-token.operation'
export type { RevokeWidgetTokenOperationData } from './revoke-widget-token/revoke-widget-token.operation'
export { ResolveWidgetTokenOperation } from './resolve-widget-token/resolve-widget-token.operation'
export type { ResolveWidgetTokenOperationData } from './resolve-widget-token/resolve-widget-token.operation'
export { RunReminderTickOperation } from './run-reminder-tick/run-reminder-tick.operation'
export type { RunReminderTickOperationData } from './run-reminder-tick/run-reminder-tick.operation'

// 3. Type re-exports (enum — значением, остальное — export type)
export type { GetNotificationSettingsResult } from './get-notification-settings/get-notification-settings.types'
export { GetNotificationSettingsOperationErrorCode } from './get-notification-settings/get-notification-settings.types'
export type { UpdateNotificationSettingsResult } from './update-notification-settings/update-notification-settings.types'
export { UpdateNotificationSettingsOperationErrorCode } from './update-notification-settings/update-notification-settings.types'
export type { CreateSubscriptionResult } from './create-subscription/create-subscription.types'
export { CreateSubscriptionOperationErrorCode } from './create-subscription/create-subscription.types'
export type { DeleteSubscriptionResult } from './delete-subscription/delete-subscription.types'
export { DeleteSubscriptionOperationErrorCode } from './delete-subscription/delete-subscription.types'
export type { MarkReminderOpenedResult } from './mark-reminder-opened/mark-reminder-opened.types'
export type { CreateWidgetTokenResult } from './create-widget-token/create-widget-token.types'
export { CreateWidgetTokenOperationErrorCode } from './create-widget-token/create-widget-token.types'
export type { RevokeWidgetTokenResult } from './revoke-widget-token/revoke-widget-token.types'
export type { ResolveWidgetTokenResult } from './resolve-widget-token/resolve-widget-token.types'
export type { RunReminderTickResult } from './run-reminder-tick/run-reminder-tick.types'
export { isValidReminderTime, reminderTextFor } from './shared/reminder-rules'
export type { NotificationSettingsDTO, PushSubscriptionDTO } from '../../managers/notifications-manager'

// 4. Union type
import type { GetNotificationSettingsOperation } from './get-notification-settings/get-notification-settings.operation'
import type { UpdateNotificationSettingsOperation } from './update-notification-settings/update-notification-settings.operation'
import type { CreateSubscriptionOperation } from './create-subscription/create-subscription.operation'
import type { DeleteSubscriptionOperation } from './delete-subscription/delete-subscription.operation'
import type { MarkReminderOpenedOperation } from './mark-reminder-opened/mark-reminder-opened.operation'
import type { CreateWidgetTokenOperation } from './create-widget-token/create-widget-token.operation'
import type { RevokeWidgetTokenOperation } from './revoke-widget-token/revoke-widget-token.operation'
import type { ResolveWidgetTokenOperation } from './resolve-widget-token/resolve-widget-token.operation'
import type { RunReminderTickOperation } from './run-reminder-tick/run-reminder-tick.operation'

export type NotificationsOperations =
  | GetNotificationSettingsOperation
  | UpdateNotificationSettingsOperation
  | CreateSubscriptionOperation
  | DeleteSubscriptionOperation
  | MarkReminderOpenedOperation
  | CreateWidgetTokenOperation
  | RevokeWidgetTokenOperation
  | ResolveWidgetTokenOperation
  | RunReminderTickOperation

// 5. Facade
export class NotificationsProcess implements INotificationsProcess {
  async execute<T extends NotificationsOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: NotificationsOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface INotificationsProcess {
  execute<T extends NotificationsOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const notificationsProcess: INotificationsProcess = new NotificationsProcess()
