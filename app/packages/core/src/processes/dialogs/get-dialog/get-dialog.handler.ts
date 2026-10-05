import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  agentApiIntegration,
  GetAgentDialogRequest,
  GetAgentDialogRequestErrorCode,
} from '../../../integrations/agent-api'
import { toDialogDTO } from '../shared/dialog.dto'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { GetDialogOperation } from './get-dialog.operation'
import { GetDialogOperationErrorCode, type GetDialogResult } from './get-dialog.types'

/**
 * A single conversation with its messages: the journal and recovery after a dropped socket.
 * Ownership of the dialog is checked by the agent because the path contains the user, so
 * another person's dialog cannot be handed out even when its identifier is known.
 */
@requestHandler(GetDialogOperation)
export class GetDialogOperationHandler implements RequestHandler<GetDialogOperation, GetDialogResult> {
  async handle(operation: GetDialogOperation): Promise<GetDialogResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: GetDialogOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: GetDialogOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const result = await agentApiIntegration.execute(
      new GetAgentDialogRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (!result.success) {
      switch (result.error) {
        case GetAgentDialogRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: GetDialogOperationErrorCode.DIALOG_NOT_FOUND }
        default:
          return assertNever(result.error)
      }
    }
    return { success: true, dialog: toDialogDTO(result.dialog) }
  }
}
