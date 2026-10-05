import { RequestData } from 'mediatr-ts'
import type { GetSessionStatusQueryResult } from './get-session-status.types'

export interface GetSessionStatusQueryData {
  sessionId: string
}

export class GetSessionStatusQuery extends RequestData<GetSessionStatusQueryResult> {
  /** Survives minification: GetSessionStatusQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetSessionStatusQuery'

  public readonly sessionId: string

  constructor(data: GetSessionStatusQueryData) {
    super()
    this.sessionId = data.sessionId
  }
}
