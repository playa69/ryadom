import { RequestData } from 'mediatr-ts'
import type { MarkReminderDeliveryCommandResult } from './mark-reminder-delivery.types'

export interface MarkReminderDeliveryCommandData {
  deliveryId: number
  error?: string
}

export class MarkReminderDeliveryCommand extends RequestData<MarkReminderDeliveryCommandResult> {
  /** Survives build minification: MarkReminderDeliveryCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'MarkReminderDeliveryCommand'

  public readonly deliveryId: number
  public readonly error?: string

  constructor(data: MarkReminderDeliveryCommandData) {
    super()
    this.deliveryId = data.deliveryId
    this.error = data.error
  }
}
