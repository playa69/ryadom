import { RequestData } from 'mediatr-ts'
import type { ListReminderCandidatesQueryResult } from './list-reminder-candidates.types'

export interface ListReminderCandidatesQueryData {
  limit: number
  afterUserId?: string
}

export class ListReminderCandidatesQuery extends RequestData<ListReminderCandidatesQueryResult> {
  /** Survives build minification: ListReminderCandidatesQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListReminderCandidatesQuery'

  public readonly limit: number
  public readonly afterUserId?: string

  constructor(data: ListReminderCandidatesQueryData) {
    super()
    this.limit = data.limit
    this.afterUserId = data.afterUserId
  }
}
