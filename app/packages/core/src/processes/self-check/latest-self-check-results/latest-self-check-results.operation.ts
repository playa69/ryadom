import { RequestData } from 'mediatr-ts'
import type { LatestSelfCheckResultsResult } from './latest-self-check-results.types'

export interface LatestSelfCheckResultsOperationData {
  userId: string
}

export class LatestSelfCheckResultsOperation extends RequestData<LatestSelfCheckResultsResult> {
  /** Survives build minification: LatestSelfCheckResultsOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'LatestSelfCheckResultsOperation'

  public readonly userId: string

  constructor(data: LatestSelfCheckResultsOperationData) {
    super()
    this.userId = data.userId
  }
}
