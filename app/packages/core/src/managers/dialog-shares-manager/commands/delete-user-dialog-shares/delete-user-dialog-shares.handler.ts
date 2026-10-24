import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { dialogShares } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeleteUserDialogSharesCommand } from './delete-user-dialog-shares.command'
import { type DeleteUserDialogSharesCommandResult } from './delete-user-dialog-shares.types'

/** Account deletion: the row is only anonymized, so its links must be removed by hand. */
@requestHandler(DeleteUserDialogSharesCommand)
export class DeleteUserDialogSharesCommandHandler implements RequestHandler<DeleteUserDialogSharesCommand, DeleteUserDialogSharesCommandResult> {
  async handle(command: DeleteUserDialogSharesCommand): Promise<DeleteUserDialogSharesCommandResult> {
    await getDb().delete(dialogShares).where(eq(dialogShares.userId, command.userId))
    return { success: true }
  }
}
