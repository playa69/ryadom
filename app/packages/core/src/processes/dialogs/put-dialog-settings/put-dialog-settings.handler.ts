import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { agentApiIntegration, PutAgentDialogSettingsRequest } from '../../../integrations/agent-api'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { PutDialogSettingsOperation } from './put-dialog-settings.operation'
import { PutDialogSettingsOperationErrorCode, type PutDialogSettingsResult } from './put-dialog-settings.types'

@requestHandler(PutDialogSettingsOperation)
export class PutDialogSettingsOperationHandler implements RequestHandler<PutDialogSettingsOperation, PutDialogSettingsResult> {
  async handle(operation: PutDialogSettingsOperation): Promise<PutDialogSettingsResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: PutDialogSettingsOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: PutDialogSettingsOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const settings = await agentApiIntegration.execute(
      new PutAgentDialogSettingsRequest({ userId: operation.userId, recapEnabled: operation.recapEnabled }),
    )
    return { success: true, recapEnabled: settings.recapEnabled }
  }
}
