import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { dialogSharesManager, RevokeDialogShareCommand } from '../../../managers/dialog-shares-manager'
import {
  agentApiIntegration,
  DeleteAgentDialogRequest,
  DeleteAgentDialogRequestErrorCode,
  GetAgentDialogRequest,
  GetAgentDialogRequestErrorCode,
} from '../../../integrations/agent-api'
import { createLogger } from '../../../shared'
import { toDialogListItemDTO } from '../shared/dialog.dto'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { DeleteDialogOperation } from './delete-dialog.operation'
import { DeleteDialogOperationErrorCode, type DeleteDialogResult } from './delete-dialog.types'

@requestHandler(DeleteDialogOperation)
export class DeleteDialogOperationHandler implements RequestHandler<DeleteDialogOperation, DeleteDialogResult> {
  async handle(operation: DeleteDialogOperation): Promise<DeleteDialogResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: DeleteDialogOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: DeleteDialogOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    // The week of the conversation is read before it goes: the diary drops that week's summary by the start date.
    const found = await agentApiIntegration.execute(
      new GetAgentDialogRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (!found.success) {
      switch (found.error) {
        case GetAgentDialogRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: DeleteDialogOperationErrorCode.DIALOG_NOT_FOUND }
        default:
          return assertNever(found.error)
      }
    }
    const startedAt = toDialogListItemDTO(found.dialog).startedAt
    const deleted = await agentApiIntegration.execute(
      new DeleteAgentDialogRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (!deleted.success) {
      switch (deleted.error) {
        case DeleteAgentDialogRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: DeleteDialogOperationErrorCode.DIALOG_NOT_FOUND }
        default:
          return assertNever(deleted.error)
      }
    }
    // The link «Поделиться» goes out with the conversation (REQ-DATA-05): the next visit gets the common «no longer valid».
    await dialogSharesManager.execute(
      new RevokeDialogShareCommand({ userId: operation.userId, dialogId: operation.dialogId, now: new Date() }),
    )
    createLogger('dialogs').info('Dialog deleted by the person', { userId: operation.userId, dialogId: operation.dialogId })
    return { success: true, startedAt }
  }
}
