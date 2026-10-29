import { RequestData } from 'mediatr-ts'
import type { ListSelfCheckResultsQueryResult } from './list-self-check-results.types'

export interface ListSelfCheckResultsQueryData {
  userId: string
  testId?: string
  before?: Date
  limit: number
}

export class ListSelfCheckResultsQuery extends RequestData<ListSelfCheckResultsQueryResult> {
  /** Survives build minification: ListSelfCheckResultsQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListSelfCheckResultsQuery'

  public readonly userId: string
  public readonly testId?: string
  public readonly before?: Date
  public readonly limit: number

  constructor(data: ListSelfCheckResultsQueryData) {
    super()
    this.userId = data.userId
    this.testId = data.testId
    this.before = data.before
    this.limit = data.limit
  }
}
