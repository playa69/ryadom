import { RequestData } from 'mediatr-ts'
import type { UpdateNotificationSettingsResult } from './update-notification-settings.types'

export interface UpdateNotificationSettingsOperationData {
  userId: string
  enabled?: boolean
  time?: string
  offerAnswered?: boolean
}

export class UpdateNotificationSettingsOperation extends RequestData<UpdateNotificationSettingsResult> {
  /** Survives build minification: UpdateNotificationSettingsOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateNotificationSettingsOperation'

  public readonly userId: string
  public readonly enabled?: boolean
  public readonly time?: string
  public readonly offerAnswered?: boolean

  constructor(data: UpdateNotificationSettingsOperationData) {
    super()
    this.userId = data.userId
    this.enabled = data.enabled
    this.time = data.time
    this.offerAnswered = data.offerAnswered
  }
}
