import { RequestData } from 'mediatr-ts'
import type { ListSelfCheckResultsResult } from './list-self-check-results.types'

export interface ListSelfCheckResultsOperationData {
  userId: string
  testId?: string
  before?: Date
  limit?: number
}

export class ListSelfCheckResultsOperation extends RequestData<ListSelfCheckResultsResult> {
  /** Survives build minification: ListSelfCheckResultsOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListSelfCheckResultsOperation'

  public readonly userId: string
  public readonly testId?: string
  public readonly before?: Date
  public readonly limit?: number

  constructor(data: ListSelfCheckResultsOperationData) {
    super()
    this.userId = data.userId
    this.testId = data.testId
    this.before = data.before
    this.limit = data.limit
  }
}
