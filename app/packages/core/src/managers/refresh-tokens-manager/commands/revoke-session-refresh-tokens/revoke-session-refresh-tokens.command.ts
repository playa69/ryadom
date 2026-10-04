import { RequestData } from 'mediatr-ts'
import type { RevokeSessionRefreshTokensCommandResult } from './revoke-session-refresh-tokens.types'

export interface RevokeSessionRefreshTokensCommandData {
  sessionId: string
  revokedAt: Date
}

export class RevokeSessionRefreshTokensCommand extends RequestData<RevokeSessionRefreshTokensCommandResult> {
  /** Survives minification: RevokeSessionRefreshTokensCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeSessionRefreshTokensCommand'

  public readonly sessionId: string
  public readonly revokedAt: Date

  constructor(data: RevokeSessionRefreshTokensCommandData) {
    super()
    this.sessionId = data.sessionId
    this.revokedAt = data.revokedAt
  }
}
