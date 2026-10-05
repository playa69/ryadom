import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { RevokeUserSessionsResult } from './revoke-user-sessions.types'

export interface RevokeUserSessionsOperationData {
  adminEmail: string
  userId: string
}

export class RevokeUserSessionsOperation extends RequestData<RevokeUserSessionsResult> {
  /** Survives minification: RevokeUserSessionsOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeUserSessionsOperation'

  @hasPII()
  public readonly adminEmail: string

  public readonly userId: string

  constructor(data: RevokeUserSessionsOperationData) {
    super()
    this.adminEmail = data.adminEmail
    this.userId = data.userId
  }
}
