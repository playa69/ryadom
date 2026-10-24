// 1. Handler imports
import './handlers'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export {
  CreateSubscriptionOperation,
  CreateWidgetTokenOperation,
  DeleteSubscriptionOperation,
  GetNotificationSettingsOperation,
  MarkReminderOpenedOperation,
  NotificationsOperationErrorCode,
  ResolveWidgetTokenOperation,
  RevokeWidgetTokenOperation,
  RunReminderTickOperation,
  UpdateNotificationSettingsOperation,
} from './operations'
export type { ReminderTickResult } from './operations'
export {
  REMINDER_BUTTON,
  REMINDER_TEXTS,
  REMINDER_TITLE,
  isValidReminderTime,
  reminderTextFor,
} from './handlers'
export type { NotificationSettingsDTO, PushSubscriptionDTO } from '../../managers/notifications-manager'

// 4. Union type
import type {
  CreateSubscriptionOperation,
  CreateWidgetTokenOperation,
  DeleteSubscriptionOperation,
  GetNotificationSettingsOperation,
  MarkReminderOpenedOperation,
  ResolveWidgetTokenOperation,
  RevokeWidgetTokenOperation,
  RunReminderTickOperation,
  UpdateNotificationSettingsOperation,
} from './operations'

export type NotificationsOperations =
  | CreateSubscriptionOperation
  | CreateWidgetTokenOperation
  | DeleteSubscriptionOperation
  | GetNotificationSettingsOperation
  | MarkReminderOpenedOperation
  | ResolveWidgetTokenOperation
  | RevokeWidgetTokenOperation
  | RunReminderTickOperation
  | UpdateNotificationSettingsOperation

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
