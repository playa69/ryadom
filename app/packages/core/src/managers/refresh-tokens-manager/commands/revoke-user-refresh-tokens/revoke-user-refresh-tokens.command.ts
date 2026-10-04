import { RequestData } from 'mediatr-ts'
import type { RevokeUserRefreshTokensCommandResult } from './revoke-user-refresh-tokens.types'

export interface RevokeUserRefreshTokensCommandData {
  userId: string
  exceptSessionId: string | null
  revokedAt: Date
}

export class RevokeUserRefreshTokensCommand extends RequestData<RevokeUserRefreshTokensCommandResult> {
  /** Survives minification: RevokeUserRefreshTokensCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeUserRefreshTokensCommand'

  public readonly userId: string
  public readonly exceptSessionId: string | null
  public readonly revokedAt: Date

  constructor(data: RevokeUserRefreshTokensCommandData) {
    super()
    this.userId = data.userId
    this.exceptSessionId = data.exceptSessionId
    this.revokedAt = data.revokedAt
  }
}
