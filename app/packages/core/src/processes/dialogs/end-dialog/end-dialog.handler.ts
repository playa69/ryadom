import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  agentApiIntegration,
  EndAgentDialogRequest,
  EndAgentDialogRequestErrorCode,
} from '../../../integrations/agent-api'
import { toDialogSummaryDTO } from '../shared/dialog.dto'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { EndDialogOperation } from './end-dialog.operation'
import { EndDialogOperationErrorCode, type EndDialogResult } from './end-dialog.types'

/**
 * Ending a conversation: "what are you taking with you" and the tension afterwards (the north star
 * is computed from the difference between before and after). It normally arrives as a socket
 * frame, but REST is needed when the socket has already dropped.
 */
@requestHandler(EndDialogOperation)
export class EndDialogOperationHandler implements RequestHandler<EndDialogOperation, EndDialogResult> {
  async handle(operation: EndDialogOperation): Promise<EndDialogResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: EndDialogOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: EndDialogOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const result = await agentApiIntegration.execute(
      new EndAgentDialogRequest({
        userId: operation.userId,
        dialogId: operation.dialogId,
        takeaway: operation.takeaway,
        tensionAfter: operation.tensionAfter,
        recapSource: operation.recapSource,
      }),
    )
    if (!result.success) {
      switch (result.error) {
        case EndAgentDialogRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: EndDialogOperationErrorCode.DIALOG_NOT_FOUND }
        default:
          return assertNever(result.error)
      }
    }
    createLogger('dialogs').info('Dialog ended', { userId: operation.userId, dialogId: operation.dialogId })
    return { success: true, summary: toDialogSummaryDTO(result.summary) }
  }
}
