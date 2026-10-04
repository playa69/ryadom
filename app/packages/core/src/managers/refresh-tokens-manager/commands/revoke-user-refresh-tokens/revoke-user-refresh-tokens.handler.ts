import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { RevokeUserRefreshTokensCommand } from './revoke-user-refresh-tokens.command'
import type { RevokeUserRefreshTokensCommandResult } from './revoke-user-refresh-tokens.types'

/**
 * Ends every session of the user, or every one but `exceptSessionId` (the session that just changed
 * the password keeps working). Tokens that were only rotated are ended too: left as they are, one
 * of them could still be exchanged during the grace window and bring the session back. Idempotent:
 * nothing to revoke is also a success.
 */
@requestHandler(RevokeUserRefreshTokensCommand)
export class RevokeUserRefreshTokensCommandHandler implements RequestHandler<
  RevokeUserRefreshTokensCommand,
  RevokeUserRefreshTokensCommandResult
> {
  async handle(command: RevokeUserRefreshTokensCommand): Promise<RevokeUserRefreshTokensCommandResult> {
    if (!isUuid(command.userId)) return { success: true }
    const except =
      command.exceptSessionId && isUuid(command.exceptSessionId)
        ? ne(refreshTokens.sessionId, command.exceptSessionId)
        : undefined
    await getDb()
      .update(refreshTokens)
      .set({ revokedAt: command.revokedAt, revokedReason: 'revoked' })
      .where(
        and(
          eq(refreshTokens.userId, command.userId),
          or(isNull(refreshTokens.revokedAt), eq(refreshTokens.revokedReason, 'rotated')),
          except,
        ),
      )
    return { success: true }
  }
}
