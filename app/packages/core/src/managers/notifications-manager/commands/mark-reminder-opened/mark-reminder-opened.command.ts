import { RequestData } from 'mediatr-ts'
import type { MarkReminderOpenedCommandResult } from './mark-reminder-opened.types'

export interface MarkReminderOpenedCommandData {
  userId: string
  deliveryId: number
}

export class MarkReminderOpenedCommand extends RequestData<MarkReminderOpenedCommandResult> {
  /** Survives build minification: MarkReminderOpenedCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'MarkReminderOpenedCommand'

  public readonly userId: string
  public readonly deliveryId: number

  constructor(data: MarkReminderOpenedCommandData) {
    super()
    this.userId = data.userId
    this.deliveryId = data.deliveryId
  }
}
