// 1. Handler imports
import './handlers'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export {
  ClaimReminderDeliveryCommand,
  CountUnopenedRemindersQuery,
  CreatePushSubscriptionCommand,
  CreateWidgetTokenCommand,
  DeletePushSubscriptionCommand,
  FindWidgetTokenQuery,
  GetNotificationSettingsQuery,
  HasMoodCheckinQuery,
  ListPushSubscriptionsQuery,
  ListReminderCandidatesQuery,
  MarkReminderDeliveryCommand,
  MarkReminderOpenedCommand,
  PauseMoodReminderCommand,
  RecordPushResultCommand,
  RevokeWidgetTokensCommand,
  UpdateNotificationSettingsCommand,
} from './requests'
export type {
  NotificationSettingsDTO,
  PushSubscriptionDTO,
  ReminderCandidateDTO,
} from './requests'
export { DEFAULT_REMINDER_TIME, MOOD_DELIVERY_KIND } from './handlers'

// 4. Union type
import type {
  ClaimReminderDeliveryCommand,
  CountUnopenedRemindersQuery,
  CreatePushSubscriptionCommand,
  CreateWidgetTokenCommand,
  DeletePushSubscriptionCommand,
  FindWidgetTokenQuery,
  GetNotificationSettingsQuery,
  HasMoodCheckinQuery,
  ListPushSubscriptionsQuery,
  ListReminderCandidatesQuery,
  MarkReminderDeliveryCommand,
  MarkReminderOpenedCommand,
  PauseMoodReminderCommand,
  RecordPushResultCommand,
  RevokeWidgetTokensCommand,
  UpdateNotificationSettingsCommand,
} from './requests'

export type NotificationsManagerRequests =
  | ClaimReminderDeliveryCommand
  | CountUnopenedRemindersQuery
  | CreatePushSubscriptionCommand
  | CreateWidgetTokenCommand
  | DeletePushSubscriptionCommand
  | FindWidgetTokenQuery
  | GetNotificationSettingsQuery
  | HasMoodCheckinQuery
  | ListPushSubscriptionsQuery
  | ListReminderCandidatesQuery
  | MarkReminderDeliveryCommand
  | MarkReminderOpenedCommand
  | PauseMoodReminderCommand
  | RecordPushResultCommand
  | RevokeWidgetTokensCommand
  | UpdateNotificationSettingsCommand

// 5. Facade
export class NotificationsManager implements INotificationsManager {
  async execute<T extends NotificationsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: NotificationsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface INotificationsManager {
  execute<T extends NotificationsManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const notificationsManager: INotificationsManager = new NotificationsManager()
