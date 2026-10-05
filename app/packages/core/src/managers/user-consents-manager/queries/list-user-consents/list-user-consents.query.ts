import { RequestData } from 'mediatr-ts'
import type { ListUserConsentsQueryResult } from './list-user-consents.types'

export interface ListUserConsentsQueryData {
  userId: string
}

export class ListUserConsentsQuery extends RequestData<ListUserConsentsQueryResult> {
  /** Survives minification: ListUserConsentsQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'ListUserConsentsQuery'

  public readonly userId: string

  constructor(data: ListUserConsentsQueryData) {
    super()
    this.userId = data.userId
  }
}
