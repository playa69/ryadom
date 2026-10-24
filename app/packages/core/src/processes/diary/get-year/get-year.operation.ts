import { RequestData } from 'mediatr-ts'
import type { GetYearResult } from './get-year.types'

export interface GetYearOperationData {
  userId: string
  year?: number
  now?: Date
}

export class GetYearOperation extends RequestData<GetYearResult> {
  /** Survives build minification: GetYearOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetYearOperation'

  public readonly userId: string
  public readonly year?: number
  public readonly now?: Date

  constructor(data: GetYearOperationData) {
    super()
    this.userId = data.userId
    this.year = data.year
    this.now = data.now
  }
}
