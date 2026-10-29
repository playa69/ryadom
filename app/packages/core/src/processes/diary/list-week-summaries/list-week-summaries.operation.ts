import { RequestData } from 'mediatr-ts'
import type { ListWeekSummariesResult } from './list-week-summaries.types'

export interface ListWeekSummariesOperationData {
  userId: string
  before?: string
}

export class ListWeekSummariesOperation extends RequestData<ListWeekSummariesResult> {
  /** Survives build minification: ListWeekSummariesOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListWeekSummariesOperation'

  public readonly userId: string
  public readonly before?: string

  constructor(data: ListWeekSummariesOperationData) {
    super()
    this.userId = data.userId
    this.before = data.before
  }
}
