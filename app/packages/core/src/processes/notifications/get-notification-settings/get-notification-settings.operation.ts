import { RequestData } from 'mediatr-ts'
import type { GetNotificationSettingsResult } from './get-notification-settings.types'

export interface GetNotificationSettingsOperationData {
  userId: string
}

export class GetNotificationSettingsOperation extends RequestData<GetNotificationSettingsResult> {
  /** Survives build minification: GetNotificationSettingsOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetNotificationSettingsOperation'

  public readonly userId: string

  constructor(data: GetNotificationSettingsOperationData) {
    super()
    this.userId = data.userId
  }
}
