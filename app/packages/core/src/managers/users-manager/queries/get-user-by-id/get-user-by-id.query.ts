import { RequestData } from 'mediatr-ts'
import type { GetUserByIdQueryResult } from './get-user-by-id.types'

export interface GetUserByIdQueryData {
  userId: string
}

export class GetUserByIdQuery extends RequestData<GetUserByIdQueryResult> {
  /** Survives minification: GetUserByIdQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetUserByIdQuery'

  public readonly userId: string

  constructor(data: GetUserByIdQueryData) {
    super()
    this.userId = data.userId
  }
}
