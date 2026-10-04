import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { GetUserByEmailQueryResult } from './get-user-by-email.types'

export interface GetUserByEmailQueryData {
  email: string
}

export class GetUserByEmailQuery extends RequestData<GetUserByEmailQueryResult> {
  /** Survives minification: GetUserByEmailQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetUserByEmailQuery'

  @hasPII()
  public readonly email: string

  constructor(data: GetUserByEmailQueryData) {
    super()
    this.email = data.email
  }
}
