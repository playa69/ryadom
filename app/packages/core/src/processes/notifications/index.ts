// 1. Handler imports
import './subscribe-push-device/subscribe-push-device.handler'
import './unsubscribe-push-device/unsubscribe-push-device.handler'
import './send-user-notification/send-user-notification.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'
import { PROCESSES_CONFIG } from '../config'

// 2. Contract re-exports
export { SubscribePushDeviceOperation } from './subscribe-push-device/subscribe-push-device.operation'
export type { SubscribePushDeviceOperationData } from './subscribe-push-device/subscribe-push-device.operation'
export { UnsubscribePushDeviceOperation } from './unsubscribe-push-device/unsubscribe-push-device.operation'
export type { UnsubscribePushDeviceOperationData } from './unsubscribe-push-device/unsubscribe-push-device.operation'
export { SendUserNotificationOperation } from './send-user-notification/send-user-notification.operation'
export type { SendUserNotificationOperationData } from './send-user-notification/send-user-notification.operation'

// 3. Type re-exports
export type { SubscribePushDeviceResult } from './subscribe-push-device/subscribe-push-device.types'
export { SubscribePushDeviceOperationErrorCode } from './subscribe-push-device/subscribe-push-device.types'
export type { UnsubscribePushDeviceResult } from './unsubscribe-push-device/unsubscribe-push-device.types'
export { UnsubscribePushDeviceOperationErrorCode } from './unsubscribe-push-device/unsubscribe-push-device.types'
export type { SendUserNotificationResult } from './send-user-notification/send-user-notification.types'
export { SendUserNotificationOperationErrorCode } from './send-user-notification/send-user-notification.types'
export { PUSH_CHANNELS, type PushChannel } from '@ryadom/db/schema'

/** What a notification may carry: the admin form checks the same lengths before the core does. */
export const NOTIFICATION_LIMITS = {
  titleMaxLength: PROCESSES_CONFIG.NOTIFICATIONS.TITLE_MAX_LENGTH,
  bodyMaxLength: PROCESSES_CONFIG.NOTIFICATIONS.BODY_MAX_LENGTH,
} as const

// 4. Union type
import type { SubscribePushDeviceOperation } from './subscribe-push-device/subscribe-push-device.operation'
import type { UnsubscribePushDeviceOperation } from './unsubscribe-push-device/unsubscribe-push-device.operation'
import type { SendUserNotificationOperation } from './send-user-notification/send-user-notification.operation'

export type NotificationsOperations =
  SubscribePushDeviceOperation | UnsubscribePushDeviceOperation | SendUserNotificationOperation

// 5. Facade
export class NotificationsProcess implements INotificationsProcess {
  async execute<T extends NotificationsOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: NotificationsOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface INotificationsProcess {
  execute<T extends NotificationsOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const notificationsProcess: INotificationsProcess = new NotificationsProcess()
