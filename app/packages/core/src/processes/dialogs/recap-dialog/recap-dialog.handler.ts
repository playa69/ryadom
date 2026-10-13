import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  agentApiIntegration,
  RecapAgentDialogRequest,
  RecapAgentDialogRequestErrorCode,
} from '../../../integrations/agent-api'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { RecapDialogOperation } from './recap-dialog.operation'
import { RecapDialogOperationErrorCode, type RecapDialogResult } from './recap-dialog.types'

/**
 * The recap for the closing sheet: what the conversation was about and where it got to, written by
 * the agent. The sheet puts it into "what are you taking with you" for the person to keep, edit or
 * erase; nothing is saved until the conversation is ended with whatever they leave there.
 */
@requestHandler(RecapDialogOperation)
export class RecapDialogOperationHandler implements RequestHandler<RecapDialogOperation, RecapDialogResult> {
  async handle(operation: RecapDialogOperation): Promise<RecapDialogResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: RecapDialogOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: RecapDialogOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const result = await agentApiIntegration.execute(
      new RecapAgentDialogRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (!result.success) {
      switch (result.error) {
        case RecapAgentDialogRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: RecapDialogOperationErrorCode.DIALOG_NOT_FOUND }
        default:
          return assertNever(result.error)
      }
    }
    return { success: true, recap: result.recap }
  }
}
