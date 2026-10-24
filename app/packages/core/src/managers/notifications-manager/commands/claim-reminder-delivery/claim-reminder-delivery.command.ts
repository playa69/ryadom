import { RequestData } from 'mediatr-ts'
import type { ClaimReminderDeliveryCommandResult } from './claim-reminder-delivery.types'

export interface ClaimReminderDeliveryCommandData {
  userId: string
  localDate: string
  channel: string
}

export class ClaimReminderDeliveryCommand extends RequestData<ClaimReminderDeliveryCommandResult> {
  /** Survives build minification: ClaimReminderDeliveryCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ClaimReminderDeliveryCommand'

  public readonly userId: string
  public readonly localDate: string
  public readonly channel: string

  constructor(data: ClaimReminderDeliveryCommandData) {
    super()
    this.userId = data.userId
    this.localDate = data.localDate
    this.channel = data.channel
  }
}
