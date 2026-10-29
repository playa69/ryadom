import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { GetActiveDialogShareQuery, dialogSharesManager } from '../../../managers/dialog-shares-manager'
import { DialogAccessRefusal, ensureActiveUser } from '../../dialogs/shared/ensure-active-user'
import { toOwnedDialogShareDTO } from '../shared/dialog-share.dto'
import { GetDialogShareOperation } from './get-dialog-share.operation'
import { GetDialogShareOperationErrorCode, type GetDialogShareResult } from './get-dialog-share.types'

/** The person's active link to a dialog, to show or copy it again. */
@requestHandler(GetDialogShareOperation)
export class GetDialogShareOperationHandler implements RequestHandler<GetDialogShareOperation, GetDialogShareResult> {
  async handle(operation: GetDialogShareOperation): Promise<GetDialogShareResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: GetDialogShareOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: GetDialogShareOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }
    const found = await dialogSharesManager.execute(
      new GetActiveDialogShareQuery({ userId: operation.userId, dialogId: operation.dialogId, now: new Date() }),
    )
    if (!found.share) return { success: false, error: GetDialogShareOperationErrorCode.SHARE_NOT_FOUND }
    return { success: true, share: toOwnedDialogShareDTO(found.share) }
  }
}
