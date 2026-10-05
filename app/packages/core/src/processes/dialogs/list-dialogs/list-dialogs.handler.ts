import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { agentApiIntegration, ListAgentDialogsRequest } from '../../../integrations/agent-api'
import { toDialogListItemDTO } from '../shared/dialog.dto'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { ListDialogsOperation } from './list-dialogs.operation'
import { ListDialogsOperationErrorCode, type ListDialogsResult } from './list-dialogs.types'

/** Conversation journal (the "Journal" screen): summaries without messages, in pages. */
@requestHandler(ListDialogsOperation)
export class ListDialogsOperationHandler implements RequestHandler<ListDialogsOperation, ListDialogsResult> {
  async handle(operation: ListDialogsOperation): Promise<ListDialogsResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: ListDialogsOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: ListDialogsOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const listed = await agentApiIntegration.execute(
      new ListAgentDialogsRequest({
        userId: operation.userId,
        limit: operation.limit,
        before: operation.before,
      }),
    )
    return { success: true, items: listed.items.map(toDialogListItemDTO), next: listed.next }
  }
}
