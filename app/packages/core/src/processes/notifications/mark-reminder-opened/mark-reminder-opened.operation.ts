import { RequestData } from 'mediatr-ts'
import type { MarkReminderOpenedResult } from './mark-reminder-opened.types'

export interface MarkReminderOpenedOperationData {
  userId: string
  deliveryId: number
}

export class MarkReminderOpenedOperation extends RequestData<MarkReminderOpenedResult> {
  /** Survives build minification: MarkReminderOpenedOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'MarkReminderOpenedOperation'

  public readonly userId: string
  public readonly deliveryId: number

  constructor(data: MarkReminderOpenedOperationData) {
    super()
    this.userId = data.userId
    this.deliveryId = data.deliveryId
  }
}
