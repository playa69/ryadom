import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { agentApiIntegration, ListAgentRecapsRequest } from '../../../integrations/agent-api'
import { toDialogRecapItemDTO, type DialogRecapItemDTO } from '../shared/dialog.dto'
import { DialogAccessRefusal, ensureActiveUser } from '../shared/ensure-active-user'
import { ListRecapsOperation } from './list-recaps.operation'
import { ListRecapsOperationErrorCode, type ListRecapsResult } from './list-recaps.types'

@requestHandler(ListRecapsOperation)
export class ListRecapsOperationHandler implements RequestHandler<ListRecapsOperation, ListRecapsResult> {
  async handle(operation: ListRecapsOperation): Promise<ListRecapsResult> {
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: ListRecapsOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: ListRecapsOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const listed = await agentApiIntegration.execute(
      new ListAgentRecapsRequest({ userId: operation.userId, limit: operation.limit, before: operation.before }),
    )
    const items = listed.items.map(toDialogRecapItemDTO).filter((item): item is DialogRecapItemDTO => item !== null)
    return { success: true, items, next: listed.next }
  }
}
