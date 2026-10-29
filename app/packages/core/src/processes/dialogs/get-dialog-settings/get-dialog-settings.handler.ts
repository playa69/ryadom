import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { agentApiIntegration, GetAgentDialogSettingsRequest } from '../../../integrations/agent-api'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { GetDialogSettingsOperation } from './get-dialog-settings.operation'
import { GetDialogSettingsOperationErrorCode, type GetDialogSettingsResult } from './get-dialog-settings.types'

@requestHandler(GetDialogSettingsOperation)
export class GetDialogSettingsOperationHandler implements RequestHandler<GetDialogSettingsOperation, GetDialogSettingsResult> {
  async handle(operation: GetDialogSettingsOperation): Promise<GetDialogSettingsResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: GetDialogSettingsOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: GetDialogSettingsOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const settings = await agentApiIntegration.execute(new GetAgentDialogSettingsRequest({ userId: operation.userId }))
    return { success: true, recapEnabled: settings.recapEnabled }
  }
}
