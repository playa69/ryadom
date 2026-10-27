import { RequestData } from 'mediatr-ts'
import type { ListUsersWithRecentCheckinsQueryResult } from './list-users-with-recent-checkins.types'

export interface ListUsersWithRecentCheckinsQueryData {
  since: string
  limit: number
}

export class ListUsersWithRecentCheckinsQuery extends RequestData<ListUsersWithRecentCheckinsQueryResult> {
  /** Survives build minification: ListUsersWithRecentCheckinsQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListUsersWithRecentCheckinsQuery'

  public readonly since: string
  public readonly limit: number

  constructor(data: ListUsersWithRecentCheckinsQueryData) {
    super()
    this.since = data.since
    this.limit = data.limit
  }
}
