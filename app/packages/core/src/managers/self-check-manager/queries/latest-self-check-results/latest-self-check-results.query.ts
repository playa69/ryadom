import { RequestData } from 'mediatr-ts'
import type { LatestSelfCheckResultsQueryResult } from './latest-self-check-results.types'

export interface LatestSelfCheckResultsQueryData {
  userId: string
}

export class LatestSelfCheckResultsQuery extends RequestData<LatestSelfCheckResultsQueryResult> {
  /** Survives build minification: LatestSelfCheckResultsQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'LatestSelfCheckResultsQuery'

  public readonly userId: string

  constructor(data: LatestSelfCheckResultsQueryData) {
    super()
    this.userId = data.userId
  }
}
