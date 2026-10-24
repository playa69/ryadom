import { RequestData } from 'mediatr-ts'
import type { UpdateNotificationSettingsCommandResult } from './update-notification-settings.types'

export interface UpdateNotificationSettingsCommandData {
  userId: string
  enabled?: boolean
  time?: string
  offerAnswered?: boolean
}

export class UpdateNotificationSettingsCommand extends RequestData<UpdateNotificationSettingsCommandResult> {
  /** Survives build minification: UpdateNotificationSettingsCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateNotificationSettingsCommand'

  public readonly userId: string
  public readonly enabled?: boolean
  public readonly time?: string
  public readonly offerAnswered?: boolean

  constructor(data: UpdateNotificationSettingsCommandData) {
    super()
    this.userId = data.userId
    this.enabled = data.enabled
    this.time = data.time
    this.offerAnswered = data.offerAnswered
  }
}
