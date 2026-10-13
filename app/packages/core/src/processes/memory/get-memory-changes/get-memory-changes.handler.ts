import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  agentApiIntegration,
  GetAgentMemoryChangesRequest,
  GetAgentMemoryChangesRequestErrorCode,
} from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { toMemoryChangesDTO } from '../shared/memory.dto'
import { GetMemoryChangesOperation } from './get-memory-changes.operation'
import { GetMemoryChangesOperationErrorCode, type GetMemoryChangesResult } from './get-memory-changes.types'

/**
 * What one conversation added to memory, for the "I remembered" card after it. The app asks every
 * few seconds while it is `pending`; the agent checks that the dialog is this person's.
 */
@requestHandler(GetMemoryChangesOperation)
export class GetMemoryChangesOperationHandler implements RequestHandler<
  GetMemoryChangesOperation,
  GetMemoryChangesResult
> {
  async handle(operation: GetMemoryChangesOperation): Promise<GetMemoryChangesResult> {
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: GetMemoryChangesOperationErrorCode.USER_NOT_FOUND }
    }
    const result = await agentApiIntegration.execute(
      new GetAgentMemoryChangesRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (!result.success) {
      switch (result.error) {
        case GetAgentMemoryChangesRequestErrorCode.DIALOG_NOT_FOUND:
          return { success: false, error: GetMemoryChangesOperationErrorCode.DIALOG_NOT_FOUND }
        default:
          return assertNever(result.error)
      }
    }
    return { success: true, changes: toMemoryChangesDTO(result.changes) }
  }
}
