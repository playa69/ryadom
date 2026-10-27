import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  agentApiIntegration,
  PutAgentRecapRequest,
  PutAgentRecapRequestErrorCode,
} from '../../../integrations/agent-api'
import { toDialogSummaryDTO } from '../shared/dialog.dto'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { PutRecapOperation } from './put-recap.operation'
import { PutRecapOperationErrorCode, type PutRecapResult } from './put-recap.types'

@requestHandler(PutRecapOperation)
export class PutRecapOperationHandler implements RequestHandler<PutRecapOperation, PutRecapResult> {
  async handle(operation: PutRecapOperation): Promise<PutRecapResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: PutRecapOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: PutRecapOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const saved = await agentApiIntegration.execute(
      new PutAgentRecapRequest({
        userId: operation.userId,
        dialogId: operation.dialogId,
        recap: operation.recap,
        source: operation.source,
      }),
    )
    if (!saved.success) {
      switch (saved.error) {
        case PutAgentRecapRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: PutRecapOperationErrorCode.DIALOG_NOT_FOUND }
        case PutAgentRecapRequestErrorCode.RECAP_NOT_AVAILABLE:
          return { success: false, error: PutRecapOperationErrorCode.RECAP_NOT_AVAILABLE }
        default:
          return assertNever(saved.error)
      }
    }
    return { success: true, summary: toDialogSummaryDTO(saved.summary) }
  }
}
