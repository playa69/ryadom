import { RequestData } from 'mediatr-ts'
import type { GetNotificationSettingsQueryResult } from './get-notification-settings.types'

export interface GetNotificationSettingsQueryData {
  userId: string
}

export class GetNotificationSettingsQuery extends RequestData<GetNotificationSettingsQueryResult> {
  /** Survives build minification: GetNotificationSettingsQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetNotificationSettingsQuery'

  public readonly userId: string

  constructor(data: GetNotificationSettingsQueryData) {
    super()
    this.userId = data.userId
  }
}
