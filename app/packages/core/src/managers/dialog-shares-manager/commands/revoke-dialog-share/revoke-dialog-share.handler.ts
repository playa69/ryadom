import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull } from 'drizzle-orm'
import { dialogShares } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RevokeDialogShareCommand } from './revoke-dialog-share.command'
import { type RevokeDialogShareCommandResult } from './revoke-dialog-share.types'


@requestHandler(RevokeDialogShareCommand)
export class RevokeDialogShareCommandHandler implements RequestHandler<RevokeDialogShareCommand, RevokeDialogShareCommandResult> {
  async handle(command: RevokeDialogShareCommand): Promise<RevokeDialogShareCommandResult> {
    await getDb()
      .update(dialogShares)
      .set({ revokedAt: command.now })
      .where(
        and(
          eq(dialogShares.userId, command.userId),
          eq(dialogShares.dialogId, command.dialogId),
          isNull(dialogShares.revokedAt),
        ),
      )
    return { success: true }
  }
}
