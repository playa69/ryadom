import { RequestData } from 'mediatr-ts'
import type { ListInactiveAnonymousUsersQueryResult } from './list-inactive-anonymous-users.types'

export interface ListInactiveAnonymousUsersQueryData {
  /** Accounts last seen before this moment. */
  inactiveSince: Date
  limit: number
}

export class ListInactiveAnonymousUsersQuery extends RequestData<ListInactiveAnonymousUsersQueryResult> {
  /** Survives minification: ListInactiveAnonymousUsersQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'ListInactiveAnonymousUsersQuery'

  public readonly inactiveSince: Date
  public readonly limit: number

  constructor(data: ListInactiveAnonymousUsersQueryData) {
    super()
    this.inactiveSince = data.inactiveSince
    this.limit = data.limit
  }
}
