import { RequestData } from 'mediatr-ts'
import type { RevokeUserSessionCommandResult } from './revoke-user-session.types'

export interface RevokeUserSessionCommandData {
  userId: string
  sessionId: string
  revokedAt: Date
}

export class RevokeUserSessionCommand extends RequestData<RevokeUserSessionCommandResult> {
  /** Survives minification: RevokeUserSessionCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeUserSessionCommand'

  public readonly userId: string
  public readonly sessionId: string
  public readonly revokedAt: Date

  constructor(data: RevokeUserSessionCommandData) {
    super()
    this.userId = data.userId
    this.sessionId = data.sessionId
    this.revokedAt = data.revokedAt
  }
}
