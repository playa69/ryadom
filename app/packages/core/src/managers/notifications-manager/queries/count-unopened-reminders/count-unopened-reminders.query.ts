import { RequestData } from 'mediatr-ts'
import type { CountUnopenedRemindersQueryResult } from './count-unopened-reminders.types'

export interface CountUnopenedRemindersQueryData {
  userId: string
  since: Date | null
  limit: number
}

export class CountUnopenedRemindersQuery extends RequestData<CountUnopenedRemindersQueryResult> {
  /** Survives build minification: CountUnopenedRemindersQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CountUnopenedRemindersQuery'

  public readonly userId: string
  public readonly since: Date | null
  public readonly limit: number

  constructor(data: CountUnopenedRemindersQueryData) {
    super()
    this.userId = data.userId
    this.since = data.since
    this.limit = data.limit
  }
}
