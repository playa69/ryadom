import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull, or } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { RevokeSessionRefreshTokensCommand } from './revoke-session-refresh-tokens.command'
import type { RevokeSessionRefreshTokensCommandResult } from './revoke-session-refresh-tokens.types'

/**
 * Signing out: ends the session, which is the whole chain of its tokens. Every token of the chain
 * goes, the already-rotated ones included, because one of those could otherwise be exchanged
 * during the grace window and bring the session back. Idempotent.
 */
@requestHandler(RevokeSessionRefreshTokensCommand)
export class RevokeSessionRefreshTokensCommandHandler implements RequestHandler<
  RevokeSessionRefreshTokensCommand,
  RevokeSessionRefreshTokensCommandResult
> {
  async handle(command: RevokeSessionRefreshTokensCommand): Promise<RevokeSessionRefreshTokensCommandResult> {
    if (!isUuid(command.sessionId)) return { success: true }
    await getDb()
      .update(refreshTokens)
      .set({ revokedAt: command.revokedAt, revokedReason: 'signed_out' })
      .where(
        and(
          eq(refreshTokens.sessionId, command.sessionId),
          or(isNull(refreshTokens.revokedAt), eq(refreshTokens.revokedReason, 'rotated')),
        ),
      )
    return { success: true }
  }
}
