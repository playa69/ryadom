import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  agentApiIntegration,
  ForgetAgentMemoryRequest,
  ForgetAgentMemoryRequestErrorCode,
} from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { ForgetMemoryOperation } from './forget-memory.operation'
import { ForgetMemoryOperationErrorCode, type ForgetMemoryResult } from './forget-memory.types'

/**
 * "Forget everything": the agent erases every fact and its history. Conversations stay, and so do
 * the switch and the consent: forgetting is not withdrawing. Works with memory off and in any mode.
 */
@requestHandler(ForgetMemoryOperation)
export class ForgetMemoryOperationHandler implements RequestHandler<
  ForgetMemoryOperation,
  ForgetMemoryResult
> {
  async handle(operation: ForgetMemoryOperation): Promise<ForgetMemoryResult> {
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: ForgetMemoryOperationErrorCode.USER_NOT_FOUND }
    }
    const forgotten = await agentApiIntegration.execute(
      new ForgetAgentMemoryRequest({ userId: operation.userId }),
    )
    if (!forgotten.success) {
      switch (forgotten.error) {
        case ForgetAgentMemoryRequestErrorCode.MEMORY_UNAVAILABLE:
          return { success: false, error: ForgetMemoryOperationErrorCode.MEMORY_UNAVAILABLE }
        default:
          return assertNever(forgotten.error)
      }
    }
    createLogger('memory').info('Memory forgotten', { userId: operation.userId })
    return { success: true }
  }
}
