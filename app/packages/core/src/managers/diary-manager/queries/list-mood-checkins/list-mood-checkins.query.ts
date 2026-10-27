import { RequestData } from 'mediatr-ts'
import type { ListMoodCheckinsQueryResult } from './list-mood-checkins.types'

export interface ListMoodCheckinsQueryData {
  userId: string
  from: string
  to: string
}

export class ListMoodCheckinsQuery extends RequestData<ListMoodCheckinsQueryResult> {
  /** Survives build minification: ListMoodCheckinsQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListMoodCheckinsQuery'

  public readonly userId: string
  public readonly from: string
  public readonly to: string

  constructor(data: ListMoodCheckinsQueryData) {
    super()
    this.userId = data.userId
    this.from = data.from
    this.to = data.to
  }
}
