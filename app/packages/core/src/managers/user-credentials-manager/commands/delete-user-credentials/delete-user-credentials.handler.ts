import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { userCredentials } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { DeleteUserCredentialsCommand } from './delete-user-credentials.command'
import type { DeleteUserCredentialsCommandResult } from './delete-user-credentials.types'

/** Deletes the user's password (account deletion). Idempotent: a missing row is also a success. */
@requestHandler(DeleteUserCredentialsCommand)
export class DeleteUserCredentialsCommandHandler implements RequestHandler<
  DeleteUserCredentialsCommand,
  DeleteUserCredentialsCommandResult
> {
  async handle(command: DeleteUserCredentialsCommand): Promise<DeleteUserCredentialsCommandResult> {
    if (isUuid(command.userId)) {
      await getDb().delete(userCredentials).where(eq(userCredentials.userId, command.userId))
    }
    return { success: true }
  }
}
