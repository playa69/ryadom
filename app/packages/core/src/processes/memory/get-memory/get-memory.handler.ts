import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { agentApiIntegration, GetAgentMemoryRequest } from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { toMemoryDTO } from '../shared/memory.dto'
import { GetMemoryOperation } from './get-memory.operation'
import { GetMemoryOperationErrorCode, type GetMemoryResult } from './get-memory.types'

/**
 * The "Memory" screen: everything the agent remembers about the person, their switch and whether
 * the feature works at all. Memory lives at the agent; it answers in any mode and with the person's
 * memory off, because seeing what is remembered is always the person's right.
 */
@requestHandler(GetMemoryOperation)
export class GetMemoryOperationHandler implements RequestHandler<GetMemoryOperation, GetMemoryResult> {
  async handle(operation: GetMemoryOperation): Promise<GetMemoryResult> {
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: GetMemoryOperationErrorCode.USER_NOT_FOUND }
    }
    const memory = await agentApiIntegration.execute(new GetAgentMemoryRequest({ userId: operation.userId }))
    return { success: true, memory: toMemoryDTO(memory) }
  }
}
