import { RequestData } from 'mediatr-ts'
import type { CountSelfCheckResultsQueryResult } from './count-self-check-results.types'

export interface CountSelfCheckResultsQueryData {
  userId: string
  resultId?: string
  testId?: string
}

export class CountSelfCheckResultsQuery extends RequestData<CountSelfCheckResultsQueryResult> {
  /** Survives build minification: CountSelfCheckResultsQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CountSelfCheckResultsQuery'

  public readonly userId: string
  public readonly resultId?: string
  public readonly testId?: string

  constructor(data: CountSelfCheckResultsQueryData) {
    super()
    this.userId = data.userId
    this.resultId = data.resultId
    this.testId = data.testId
  }
}
