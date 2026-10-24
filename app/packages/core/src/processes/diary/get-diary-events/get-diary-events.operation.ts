import { RequestData } from 'mediatr-ts'
import type { GetDiaryEventsResult } from './get-diary-events.types'

export interface GetDiaryEventsOperationData {
  userId: string
  weekStart?: string
  now?: Date
}

export class GetDiaryEventsOperation extends RequestData<GetDiaryEventsResult> {
  /** Survives build minification: GetDiaryEventsOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetDiaryEventsOperation'

  public readonly userId: string
  public readonly weekStart?: string
  public readonly now?: Date

  constructor(data: GetDiaryEventsOperationData) {
    super()
    this.userId = data.userId
    this.weekStart = data.weekStart
    this.now = data.now
  }
}
