import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { StoreRefreshTokenCommand } from './store-refresh-token.command'
import {
  StoreRefreshTokenCommandErrorCode,
  type StoreRefreshTokenCommandResult,
} from './store-refresh-token.types'

/** Registers a refresh token. The id is the token's `jti`, chosen by the caller. */
@requestHandler(StoreRefreshTokenCommand)
export class StoreRefreshTokenCommandHandler implements RequestHandler<
  StoreRefreshTokenCommand,
  StoreRefreshTokenCommandResult
> {
  async handle(command: StoreRefreshTokenCommand): Promise<StoreRefreshTokenCommandResult> {
    const [row] = await getDb()
      .insert(refreshTokens)
      .values({
        id: command.tokenId,
        sessionId: command.sessionId,
        userId: command.userId,
        expiresAt: command.expiresAt,
        clientId: command.clientId,
        userAgent: command.userAgent,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: refreshTokens.id })
      .returning({ id: refreshTokens.id })
    if (!row) return { success: false, error: StoreRefreshTokenCommandErrorCode.TOKEN_ALREADY_EXISTS }
    return { success: true }
  }
}
