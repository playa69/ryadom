import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { RevokeRefreshTokenCommand } from './revoke-refresh-token.command'
import {
  RevokeRefreshTokenCommandErrorCode,
  type RevokeRefreshTokenCommandResult,
} from './revoke-refresh-token.types'

/**
 * Retires a token. Of two requests that retire the same token at once exactly one succeeds: the
 * UPDATE only matches a token that is still active, so the loser learns it lost (TOKEN_NOT_ACTIVE)
 * instead of both issuing a successor.
 */
@requestHandler(RevokeRefreshTokenCommand)
export class RevokeRefreshTokenCommandHandler implements RequestHandler<
  RevokeRefreshTokenCommand,
  RevokeRefreshTokenCommandResult
> {
  async handle(command: RevokeRefreshTokenCommand): Promise<RevokeRefreshTokenCommandResult> {
    if (!isUuid(command.tokenId))
      return { success: false, error: RevokeRefreshTokenCommandErrorCode.TOKEN_NOT_ACTIVE }
    const [row] = await getDb()
      .update(refreshTokens)
      .set({ revokedAt: command.revokedAt, revokedReason: command.reason })
      .where(and(eq(refreshTokens.id, command.tokenId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id })
    if (!row) return { success: false, error: RevokeRefreshTokenCommandErrorCode.TOKEN_NOT_ACTIVE }
    return { success: true }
  }
}
