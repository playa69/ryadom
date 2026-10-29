import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { dialogSharesManager, RevokeDialogShareCommand } from '../../../managers/dialog-shares-manager'
import {
  agentApiIntegration,
  GetAgentDialogRequest,
  GetAgentDialogRequestErrorCode,
} from '../../../integrations/agent-api'
import { createLogger } from '../../../shared'
import { ConfirmDialogDeletedOperation } from './confirm-dialog-deleted.operation'
import type { ConfirmDialogDeletedResult } from './confirm-dialog-deleted.types'

/**
 * The agent is the source of truth for whether the conversation exists: the job was queued before the agent was asked
 * to delete it, so it may run after a deletion that happened, one that failed, and one that never reached the agent.
 * An agent that does not answer throws (`AgentUnavailableError`), and the job is retried.
 */
@requestHandler(ConfirmDialogDeletedOperation)
export class ConfirmDialogDeletedOperationHandler implements RequestHandler<
  ConfirmDialogDeletedOperation,
  ConfirmDialogDeletedResult
> {
  async handle(operation: ConfirmDialogDeletedOperation): Promise<ConfirmDialogDeletedResult> {
    const found = await agentApiIntegration.execute(
      new GetAgentDialogRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (found.success) return { success: true, deleted: false }
    switch (found.error) {
      case GetAgentDialogRequestErrorCode.DIALOG_NOT_FOUND:
        break
      default:
        return assertNever(found.error)
    }
    // The link «Поделиться» goes out with the conversation (REQ-DATA-05); revoking twice changes nothing.
    await dialogSharesManager.execute(
      new RevokeDialogShareCommand({
        userId: operation.userId,
        dialogId: operation.dialogId,
        now: new Date(),
      }),
    )
    createLogger('dialogs').info('Dialog confirmed deleted', {
      userId: operation.userId,
      dialogId: operation.dialogId,
    })
    return { success: true, deleted: true }
  }
}
