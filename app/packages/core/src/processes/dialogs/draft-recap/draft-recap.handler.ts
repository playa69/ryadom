import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  agentApiIntegration,
  DraftAgentRecapRequest,
  DraftAgentRecapRequestErrorCode,
} from '../../../integrations/agent-api'
import { toRecapText } from '../shared/dialog.dto'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { DraftRecapOperation } from './draft-recap.operation'
import { DraftRecapOperationErrorCode, type DraftRecapResult } from './draft-recap.types'

@requestHandler(DraftRecapOperation)
export class DraftRecapOperationHandler implements RequestHandler<DraftRecapOperation, DraftRecapResult> {
  async handle(operation: DraftRecapOperation): Promise<DraftRecapResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: DraftRecapOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: DraftRecapOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const drafted = await agentApiIntegration.execute(
      new DraftAgentRecapRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (!drafted.success) {
      switch (drafted.error) {
        case DraftAgentRecapRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: DraftRecapOperationErrorCode.DIALOG_NOT_FOUND }
        case DraftAgentRecapRequestErrorCode.RECAP_NOT_AVAILABLE:
          return { success: false, error: DraftRecapOperationErrorCode.RECAP_NOT_AVAILABLE }
        case DraftAgentRecapRequestErrorCode.UNAVAILABLE:
          return { success: false, error: DraftRecapOperationErrorCode.UNAVAILABLE }
        default:
          return assertNever(drafted.error)
      }
    }
    const recap = toRecapText(drafted.recap)
    if (!recap) return { success: false, error: DraftRecapOperationErrorCode.UNAVAILABLE }
    return { success: true, recap }
  }
}
