import { RequestData } from 'mediatr-ts'
import type { GetSelfCheckResultQueryResult } from './get-self-check-result.types'

export interface GetSelfCheckResultQueryData {
  userId: string
  resultId: string
}

export class GetSelfCheckResultQuery extends RequestData<GetSelfCheckResultQueryResult> {
  /** Survives build minification: GetSelfCheckResultQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetSelfCheckResultQuery'

  public readonly userId: string
  public readonly resultId: string

  constructor(data: GetSelfCheckResultQueryData) {
    super()
    this.userId = data.userId
    this.resultId = data.resultId
  }
}
