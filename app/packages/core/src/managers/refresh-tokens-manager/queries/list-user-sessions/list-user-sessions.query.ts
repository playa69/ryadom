import { RequestData } from 'mediatr-ts'
import type { ListUserSessionsQueryResult } from './list-user-sessions.types'

export interface ListUserSessionsQueryData {
  userId: string
  /** A session whose tokens have all expired by now is not live. */
  now: Date
}

export class ListUserSessionsQuery extends RequestData<ListUserSessionsQueryResult> {
  /** Survives minification: ListUserSessionsQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'ListUserSessionsQuery'

  public readonly userId: string
  public readonly now: Date

  constructor(data: ListUserSessionsQueryData) {
    super()
    this.userId = data.userId
    this.now = data.now
  }
}
