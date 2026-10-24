import { RequestData } from 'mediatr-ts'
import type { GetReminderDeliveryQueryResult } from './get-reminder-delivery.types'

export interface GetReminderDeliveryQueryData {
  userId: string
  localDate: string
}

export class GetReminderDeliveryQuery extends RequestData<GetReminderDeliveryQueryResult> {
  /** Survives build minification: GetReminderDeliveryQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetReminderDeliveryQuery'

  public readonly userId: string
  public readonly localDate: string

  constructor(data: GetReminderDeliveryQueryData) {
    super()
    this.userId = data.userId
    this.localDate = data.localDate
  }
}
