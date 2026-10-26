import { RequestData } from 'mediatr-ts'
import type { CreateWeekSummaryResult } from './create-week-summary.types'

export interface CreateWeekSummaryOperationData {
  userId: string
  weekStart: string
  now?: Date
}

export class CreateWeekSummaryOperation extends RequestData<CreateWeekSummaryResult> {
  /** Survives build minification: CreateWeekSummaryOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateWeekSummaryOperation'

  public readonly userId: string
  public readonly weekStart: string
  public readonly now?: Date

  constructor(data: CreateWeekSummaryOperationData) {
    super()
    this.userId = data.userId
    this.weekStart = data.weekStart
    this.now = data.now
  }
}
