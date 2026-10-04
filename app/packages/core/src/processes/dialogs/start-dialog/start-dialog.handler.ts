import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import { agentApiIntegration, StartAgentDialogRequest } from '../../../integrations/agent-api'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { StartDialogOperation } from './start-dialog.operation'
import { StartDialogOperationErrorCode, type StartDialogResult } from './start-dialog.types'

/**
 * Start a conversation or return to an open one. The dialog lives on the agent
 * side: we only check that the account is alive and not blocked, and pass its identifier. If
 * the agent is unavailable, `AgentUnavailableError` is thrown, the application answers 503 and
 * shows the help lines.
 */
@requestHandler(StartDialogOperation)
export class StartDialogOperationHandler implements RequestHandler<StartDialogOperation, StartDialogResult> {
  async handle(operation: StartDialogOperation): Promise<StartDialogResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: StartDialogOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: StartDialogOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const started = await agentApiIntegration.execute(
      new StartAgentDialogRequest({ userId: operation.userId }),
    )
    createLogger('dialogs').info('Dialog started', {
      userId: operation.userId,
      dialogId: started.dialogId,
      resumed: started.resumed,
    })
    return { success: true, dialog: started }
  }
}
