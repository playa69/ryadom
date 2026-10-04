import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { lt } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeleteExpiredRefreshTokensCommand } from './delete-expired-refresh-tokens.command'
import type { DeleteExpiredRefreshTokensCommandResult } from './delete-expired-refresh-tokens.types'

/** Housekeeping: a token that expired before `before` can neither be used nor reveal a replay any more. */
@requestHandler(DeleteExpiredRefreshTokensCommand)
export class DeleteExpiredRefreshTokensCommandHandler implements RequestHandler<
  DeleteExpiredRefreshTokensCommand,
  DeleteExpiredRefreshTokensCommandResult
> {
  async handle(command: DeleteExpiredRefreshTokensCommand): Promise<DeleteExpiredRefreshTokensCommandResult> {
    await getDb().delete(refreshTokens).where(lt(refreshTokens.expiresAt, command.before))
    return { success: true }
  }
}
