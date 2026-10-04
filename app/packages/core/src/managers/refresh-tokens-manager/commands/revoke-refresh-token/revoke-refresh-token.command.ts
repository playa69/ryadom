import { RequestData } from 'mediatr-ts'
import type { RefreshTokenRevokeReason } from '@ryadom/db/schema'
import type { RevokeRefreshTokenCommandResult } from './revoke-refresh-token.types'

export interface RevokeRefreshTokenCommandData {
  tokenId: string
  reason: RefreshTokenRevokeReason
  revokedAt: Date
}

export class RevokeRefreshTokenCommand extends RequestData<RevokeRefreshTokenCommandResult> {
  /** Survives minification: RevokeRefreshTokenCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeRefreshTokenCommand'

  public readonly tokenId: string
  public readonly reason: RefreshTokenRevokeReason
  public readonly revokedAt: Date

  constructor(data: RevokeRefreshTokenCommandData) {
    super()
    this.tokenId = data.tokenId
    this.reason = data.reason
    this.revokedAt = data.revokedAt
  }
}
