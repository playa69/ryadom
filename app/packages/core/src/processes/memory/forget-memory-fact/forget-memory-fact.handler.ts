import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  agentApiIntegration,
  DeleteAgentMemoryFactRequest,
  DeleteAgentMemoryFactRequestErrorCode,
} from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { ForgetMemoryFactOperation } from './forget-memory-fact.operation'
import { ForgetMemoryFactOperationErrorCode, type ForgetMemoryFactResult } from './forget-memory-fact.types'

/**
 * "Forget" one note. It works with memory off, and a repeat succeeds: what was asked for, the note
 * gone, holds. The agent remembers that the person forgot it, so the next extraction does not
 * bring it back.
 */
@requestHandler(ForgetMemoryFactOperation)
export class ForgetMemoryFactOperationHandler implements RequestHandler<
  ForgetMemoryFactOperation,
  ForgetMemoryFactResult
> {
  async handle(operation: ForgetMemoryFactOperation): Promise<ForgetMemoryFactResult> {
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: ForgetMemoryFactOperationErrorCode.USER_NOT_FOUND }
    }
    const forgotten = await agentApiIntegration.execute(
      new DeleteAgentMemoryFactRequest({ userId: operation.userId, factId: operation.factId }),
    )
    if (!forgotten.success) {
      switch (forgotten.error) {
        case DeleteAgentMemoryFactRequestErrorCode.MEMORY_UNAVAILABLE:
          return { success: false, error: ForgetMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE }
        default:
          return assertNever(forgotten.error)
      }
    }
    createLogger('memory').info('Memory note forgotten', {
      userId: operation.userId,
      factId: operation.factId,
    })
    return { success: true }
  }
}
