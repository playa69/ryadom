import { RequestData } from 'mediatr-ts'
import type { GetReplyCountQueryResult } from './get-reply-count.types'

export interface GetReplyCountQueryData {
  userId: string
}

export class GetReplyCountQuery extends RequestData<GetReplyCountQueryResult> {
  /** Survives minification: GetReplyCountQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetReplyCountQuery'

  public readonly userId: string

  constructor(data: GetReplyCountQueryData) {
    super()
    this.userId = data.userId
  }
}
