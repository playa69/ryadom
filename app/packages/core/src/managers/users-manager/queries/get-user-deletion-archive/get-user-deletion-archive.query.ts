import { RequestData } from 'mediatr-ts'
import type { GetUserDeletionArchiveQueryResult } from './get-user-deletion-archive.types'

export interface GetUserDeletionArchiveQueryData {
  userId: string
}

export class GetUserDeletionArchiveQuery extends RequestData<GetUserDeletionArchiveQueryResult> {
  /** Survives minification: GetUserDeletionArchiveQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetUserDeletionArchiveQuery'

  public readonly userId: string

  constructor(data: GetUserDeletionArchiveQueryData) {
    super()
    this.userId = data.userId
  }
}
