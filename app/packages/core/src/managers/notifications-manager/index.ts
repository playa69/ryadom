// 1. Handler imports
import './commands/update-notification-settings/update-notification-settings.handler'
import './commands/create-push-subscription/create-push-subscription.handler'
import './commands/delete-push-subscription/delete-push-subscription.handler'
import './commands/record-push-result/record-push-result.handler'
import './commands/claim-reminder-delivery/claim-reminder-delivery.handler'
import './commands/mark-reminder-delivery/mark-reminder-delivery.handler'
import './commands/mark-reminder-opened/mark-reminder-opened.handler'
import './commands/pause-mood-reminder/pause-mood-reminder.handler'
import './commands/create-widget-token/create-widget-token.handler'
import './commands/revoke-widget-tokens/revoke-widget-tokens.handler'
import './commands/delete-user-notifications/delete-user-notifications.handler'
import './queries/get-notification-settings/get-notification-settings.handler'
import './queries/list-push-subscriptions/list-push-subscriptions.handler'
import './queries/find-push-subscription/find-push-subscription.handler'
import './queries/list-reminder-candidates/list-reminder-candidates.handler'
import './queries/count-unopened-reminders/count-unopened-reminders.handler'
import './queries/get-reminder-delivery/get-reminder-delivery.handler'
import './queries/find-widget-token/find-widget-token.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { UpdateNotificationSettingsCommand } from './commands/update-notification-settings/update-notification-settings.command'
export type { UpdateNotificationSettingsCommandData } from './commands/update-notification-settings/update-notification-settings.command'
export { CreatePushSubscriptionCommand } from './commands/create-push-subscription/create-push-subscription.command'
export type { CreatePushSubscriptionCommandData } from './commands/create-push-subscription/create-push-subscription.command'
export { DeletePushSubscriptionCommand } from './commands/delete-push-subscription/delete-push-subscription.command'
export type { DeletePushSubscriptionCommandData } from './commands/delete-push-subscription/delete-push-subscription.command'
export { RecordPushResultCommand } from './commands/record-push-result/record-push-result.command'
export type { RecordPushResultCommandData } from './commands/record-push-result/record-push-result.command'
export { ClaimReminderDeliveryCommand } from './commands/claim-reminder-delivery/claim-reminder-delivery.command'
export type { ClaimReminderDeliveryCommandData } from './commands/claim-reminder-delivery/claim-reminder-delivery.command'
export { MarkReminderDeliveryCommand } from './commands/mark-reminder-delivery/mark-reminder-delivery.command'
export type { MarkReminderDeliveryCommandData } from './commands/mark-reminder-delivery/mark-reminder-delivery.command'
export { MarkReminderOpenedCommand } from './commands/mark-reminder-opened/mark-reminder-opened.command'
export type { MarkReminderOpenedCommandData } from './commands/mark-reminder-opened/mark-reminder-opened.command'
export { PauseMoodReminderCommand } from './commands/pause-mood-reminder/pause-mood-reminder.command'
export type { PauseMoodReminderCommandData } from './commands/pause-mood-reminder/pause-mood-reminder.command'
export { CreateWidgetTokenCommand } from './commands/create-widget-token/create-widget-token.command'
export type { CreateWidgetTokenCommandData } from './commands/create-widget-token/create-widget-token.command'
export { RevokeWidgetTokensCommand } from './commands/revoke-widget-tokens/revoke-widget-tokens.command'
export type { RevokeWidgetTokensCommandData } from './commands/revoke-widget-tokens/revoke-widget-tokens.command'
export { DeleteUserNotificationsCommand } from './commands/delete-user-notifications/delete-user-notifications.command'
export type { DeleteUserNotificationsCommandData } from './commands/delete-user-notifications/delete-user-notifications.command'
export { GetNotificationSettingsQuery } from './queries/get-notification-settings/get-notification-settings.query'
export type { GetNotificationSettingsQueryData } from './queries/get-notification-settings/get-notification-settings.query'
export { ListPushSubscriptionsQuery } from './queries/list-push-subscriptions/list-push-subscriptions.query'
export type { ListPushSubscriptionsQueryData } from './queries/list-push-subscriptions/list-push-subscriptions.query'
export { FindPushSubscriptionQuery } from './queries/find-push-subscription/find-push-subscription.query'
export type { FindPushSubscriptionQueryData } from './queries/find-push-subscription/find-push-subscription.query'
export { ListReminderCandidatesQuery } from './queries/list-reminder-candidates/list-reminder-candidates.query'
export type { ListReminderCandidatesQueryData } from './queries/list-reminder-candidates/list-reminder-candidates.query'
export { CountUnopenedRemindersQuery } from './queries/count-unopened-reminders/count-unopened-reminders.query'
export type { CountUnopenedRemindersQueryData } from './queries/count-unopened-reminders/count-unopened-reminders.query'
export { GetReminderDeliveryQuery } from './queries/get-reminder-delivery/get-reminder-delivery.query'
export type { GetReminderDeliveryQueryData } from './queries/get-reminder-delivery/get-reminder-delivery.query'
export { FindWidgetTokenQuery } from './queries/find-widget-token/find-widget-token.query'
export type { FindWidgetTokenQueryData } from './queries/find-widget-token/find-widget-token.query'

// 3. Type re-exports (enum — значением, остальное — export type)
export type { UpdateNotificationSettingsCommandResult } from './commands/update-notification-settings/update-notification-settings.types'
export type { CreatePushSubscriptionCommandResult } from './commands/create-push-subscription/create-push-subscription.types'
export type { DeletePushSubscriptionCommandResult } from './commands/delete-push-subscription/delete-push-subscription.types'
export { DeletePushSubscriptionCommandErrorCode } from './commands/delete-push-subscription/delete-push-subscription.types'
export type { RecordPushResultCommandResult } from './commands/record-push-result/record-push-result.types'
export type { ClaimReminderDeliveryCommandResult } from './commands/claim-reminder-delivery/claim-reminder-delivery.types'
export { ClaimReminderDeliveryCommandErrorCode } from './commands/claim-reminder-delivery/claim-reminder-delivery.types'
export type { MarkReminderDeliveryCommandResult } from './commands/mark-reminder-delivery/mark-reminder-delivery.types'
export type { MarkReminderOpenedCommandResult } from './commands/mark-reminder-opened/mark-reminder-opened.types'
export { MarkReminderOpenedCommandErrorCode } from './commands/mark-reminder-opened/mark-reminder-opened.types'
export type { PauseMoodReminderCommandResult } from './commands/pause-mood-reminder/pause-mood-reminder.types'
export type { CreateWidgetTokenCommandResult } from './commands/create-widget-token/create-widget-token.types'
export type { RevokeWidgetTokensCommandResult } from './commands/revoke-widget-tokens/revoke-widget-tokens.types'
export type { DeleteUserNotificationsCommandResult } from './commands/delete-user-notifications/delete-user-notifications.types'
export type { GetNotificationSettingsQueryResult } from './queries/get-notification-settings/get-notification-settings.types'
export type { ListPushSubscriptionsQueryResult } from './queries/list-push-subscriptions/list-push-subscriptions.types'
export type { FindPushSubscriptionQueryResult } from './queries/find-push-subscription/find-push-subscription.types'
export type { ListReminderCandidatesQueryResult } from './queries/list-reminder-candidates/list-reminder-candidates.types'
export type { CountUnopenedRemindersQueryResult } from './queries/count-unopened-reminders/count-unopened-reminders.types'
export type { GetReminderDeliveryQueryResult } from './queries/get-reminder-delivery/get-reminder-delivery.types'
export type { FindWidgetTokenQueryResult } from './queries/find-widget-token/find-widget-token.types'
export type { NotificationSettingsDTO, PushSubscriptionDTO, ReminderCandidateDTO } from './shared/notifications.dto'
export { DEFAULT_REMINDER_TIME, MOOD_DELIVERY_KIND } from './shared/notifications.dto'

// 4. Union type
import type { UpdateNotificationSettingsCommand } from './commands/update-notification-settings/update-notification-settings.command'
import type { CreatePushSubscriptionCommand } from './commands/create-push-subscription/create-push-subscription.command'
import type { DeletePushSubscriptionCommand } from './commands/delete-push-subscription/delete-push-subscription.command'
import type { RecordPushResultCommand } from './commands/record-push-result/record-push-result.command'
import type { ClaimReminderDeliveryCommand } from './commands/claim-reminder-delivery/claim-reminder-delivery.command'
import type { MarkReminderDeliveryCommand } from './commands/mark-reminder-delivery/mark-reminder-delivery.command'
import type { MarkReminderOpenedCommand } from './commands/mark-reminder-opened/mark-reminder-opened.command'
import type { PauseMoodReminderCommand } from './commands/pause-mood-reminder/pause-mood-reminder.command'
import type { CreateWidgetTokenCommand } from './commands/create-widget-token/create-widget-token.command'
import type { RevokeWidgetTokensCommand } from './commands/revoke-widget-tokens/revoke-widget-tokens.command'
import type { DeleteUserNotificationsCommand } from './commands/delete-user-notifications/delete-user-notifications.command'
import type { GetNotificationSettingsQuery } from './queries/get-notification-settings/get-notification-settings.query'
import type { ListPushSubscriptionsQuery } from './queries/list-push-subscriptions/list-push-subscriptions.query'
import type { FindPushSubscriptionQuery } from './queries/find-push-subscription/find-push-subscription.query'
import type { ListReminderCandidatesQuery } from './queries/list-reminder-candidates/list-reminder-candidates.query'
import type { CountUnopenedRemindersQuery } from './queries/count-unopened-reminders/count-unopened-reminders.query'
import type { GetReminderDeliveryQuery } from './queries/get-reminder-delivery/get-reminder-delivery.query'
import type { FindWidgetTokenQuery } from './queries/find-widget-token/find-widget-token.query'

export type NotificationsManagerRequests =
  | UpdateNotificationSettingsCommand
  | CreatePushSubscriptionCommand
  | DeletePushSubscriptionCommand
  | RecordPushResultCommand
  | ClaimReminderDeliveryCommand
  | MarkReminderDeliveryCommand
  | MarkReminderOpenedCommand
  | PauseMoodReminderCommand
  | CreateWidgetTokenCommand
  | RevokeWidgetTokensCommand
  | DeleteUserNotificationsCommand
  | GetNotificationSettingsQuery
  | ListPushSubscriptionsQuery
  | FindPushSubscriptionQuery
  | ListReminderCandidatesQuery
  | CountUnopenedRemindersQuery
  | GetReminderDeliveryQuery
  | FindWidgetTokenQuery

// 5. Facade
export class NotificationsManager implements INotificationsManager {
  async execute<T extends NotificationsManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: NotificationsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface INotificationsManager {
  execute<T extends NotificationsManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const notificationsManager: INotificationsManager = new NotificationsManager()
