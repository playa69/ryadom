import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull, or } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { RevokeUserSessionCommand } from './revoke-user-session.command'
import {
  RevokeUserSessionCommandErrorCode,
  type RevokeUserSessionCommandResult,
} from './revoke-user-session.types'

/**
 * The person ends one of their own sessions from the list of devices. The user id is part of the
 * condition, so a session id taken from somebody else's list ends nothing. Like the other ways of
 * ending a session, it takes the whole chain, rotated tokens included, so none of them can be
 * exchanged during the grace window.
 */
@requestHandler(RevokeUserSessionCommand)
export class RevokeUserSessionCommandHandler implements RequestHandler<
  RevokeUserSessionCommand,
  RevokeUserSessionCommandResult
> {
  async handle(command: RevokeUserSessionCommand): Promise<RevokeUserSessionCommandResult> {
    if (!isUuid(command.userId) || !isUuid(command.sessionId)) {
      return { success: false, error: RevokeUserSessionCommandErrorCode.SESSION_NOT_FOUND }
    }
    const ended = await getDb()
      .update(refreshTokens)
      .set({ revokedAt: command.revokedAt, revokedReason: 'revoked' })
      .where(
        and(
          eq(refreshTokens.sessionId, command.sessionId),
          eq(refreshTokens.userId, command.userId),
          or(isNull(refreshTokens.revokedAt), eq(refreshTokens.revokedReason, 'rotated')),
        ),
      )
      .returning({ id: refreshTokens.id })
    if (ended.length === 0) {
      return { success: false, error: RevokeUserSessionCommandErrorCode.SESSION_NOT_FOUND }
    }
    return { success: true }
  }
}
