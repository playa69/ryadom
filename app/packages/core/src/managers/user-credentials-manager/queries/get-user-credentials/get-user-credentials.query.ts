import { RequestData } from 'mediatr-ts'
import type { GetUserCredentialsQueryResult } from './get-user-credentials.types'

export interface GetUserCredentialsQueryData {
  userId: string
}

export class GetUserCredentialsQuery extends RequestData<GetUserCredentialsQueryResult> {
  /** Survives minification: GetUserCredentialsQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetUserCredentialsQuery'

  public readonly userId: string

  constructor(data: GetUserCredentialsQueryData) {
    super()
    this.userId = data.userId
  }
}
