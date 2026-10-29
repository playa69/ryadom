import { RequestData } from 'mediatr-ts'
import type { GetMoodCheckinQueryResult } from './get-mood-checkin.types'

export interface GetMoodCheckinQueryData {
  userId: string
  localDate: string
}

export class GetMoodCheckinQuery extends RequestData<GetMoodCheckinQueryResult> {
  /** Survives build minification: GetMoodCheckinQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetMoodCheckinQuery'

  public readonly userId: string
  public readonly localDate: string

  constructor(data: GetMoodCheckinQueryData) {
    super()
    this.userId = data.userId
    this.localDate = data.localDate
  }
}
