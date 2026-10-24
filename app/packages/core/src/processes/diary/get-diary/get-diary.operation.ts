import { RequestData } from 'mediatr-ts'
import type { GetDiaryResult } from './get-diary.types'

export interface GetDiaryOperationData {
  userId: string
  month?: string
  now?: Date
}

export class GetDiaryOperation extends RequestData<GetDiaryResult> {
  /** Survives build minification: GetDiaryOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetDiaryOperation'

  public readonly userId: string
  public readonly month?: string
  public readonly now?: Date

  constructor(data: GetDiaryOperationData) {
    super()
    this.userId = data.userId
    this.month = data.month
    this.now = data.now
  }
}
