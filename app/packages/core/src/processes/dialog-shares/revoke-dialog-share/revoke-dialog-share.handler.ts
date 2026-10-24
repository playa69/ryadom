import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { RevokeDialogShareCommand, dialogSharesManager } from '../../../managers/dialog-shares-manager'
import { DialogAccessRefusal, ensureActiveUser } from '../../dialogs/shared/ensure-active-user'
import { RevokeDialogShareOperation } from './revoke-dialog-share.operation'
import { RevokeDialogShareOperationErrorCode, type RevokeDialogShareResult } from './revoke-dialog-share.types'

/** Takes the link back at once; the next visit gets the common "no longer valid". */
@requestHandler(RevokeDialogShareOperation)
export class RevokeDialogShareOperationHandler implements RequestHandler<
  RevokeDialogShareOperation,
  RevokeDialogShareResult
> {
  async handle(operation: RevokeDialogShareOperation): Promise<RevokeDialogShareResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: RevokeDialogShareOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: RevokeDialogShareOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }
    await dialogSharesManager.execute(
      new RevokeDialogShareCommand({ userId: operation.userId, dialogId: operation.dialogId, now: new Date() }),
    )
    return { success: true }
  }
}
