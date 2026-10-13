import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, validateInput } from '../../../shared'
import {
  agentApiIntegration,
  UpdateAgentMemoryFactRequest,
  UpdateAgentMemoryFactRequestErrorCode,
} from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { toMemoryFactDTO } from '../shared/memory.dto'
import { UpdateMemoryFactOperation } from './update-memory-fact.operation'
import { UpdateMemoryFactOperationErrorCode, type UpdateMemoryFactResult } from './update-memory-fact.types'
import { updateMemoryFactSchema } from './update-memory-fact.validator'

/**
 * One change to one fact: "Correct" (it becomes the person's and pinned), "Remember" a proposed one,
 * "Pin"/"Unpin", "Right". The agent checks that the fact is this person's: the path carries them.
 */
@requestHandler(UpdateMemoryFactOperation)
export class UpdateMemoryFactOperationHandler implements RequestHandler<
  UpdateMemoryFactOperation,
  UpdateMemoryFactResult
> {
  async handle(operation: UpdateMemoryFactOperation): Promise<UpdateMemoryFactResult> {
    const input = validateInput(updateMemoryFactSchema, {
      factId: operation.factId,
      text: operation.text,
      hasSlots: operation.slots !== undefined,
      status: operation.status,
      confirm: operation.confirm,
    })
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: UpdateMemoryFactOperationErrorCode.USER_NOT_FOUND }
    }
    const updated = await agentApiIntegration.execute(
      new UpdateAgentMemoryFactRequest({
        userId: operation.userId,
        factId: operation.factId,
        text: input.text,
        slots: operation.slots,
        status: input.status,
        confirm: input.confirm,
      }),
    )
    if (!updated.success) {
      switch (updated.error) {
        case UpdateAgentMemoryFactRequestErrorCode.FACT_NOT_FOUND:
          return { success: false, error: UpdateMemoryFactOperationErrorCode.FACT_NOT_FOUND }
        case UpdateAgentMemoryFactRequestErrorCode.MEMORY_DISABLED:
          return { success: false, error: UpdateMemoryFactOperationErrorCode.MEMORY_DISABLED }
        case UpdateAgentMemoryFactRequestErrorCode.FACT_REJECTED:
          createLogger('memory').info('Memory fact correction refused by the rules', {
            userId: operation.userId,
            factId: operation.factId,
            reason: updated.reason,
          })
          return {
            success: false,
            error: UpdateMemoryFactOperationErrorCode.FACT_REJECTED,
            reason: updated.reason,
          }
        case UpdateAgentMemoryFactRequestErrorCode.MEMORY_UNAVAILABLE:
          return { success: false, error: UpdateMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE }
        case UpdateAgentMemoryFactRequestErrorCode.INVALID_REQUEST:
          return { success: false, error: UpdateMemoryFactOperationErrorCode.INVALID_FACT }
        default:
          return assertNever(updated)
      }
    }
    return { success: true, fact: toMemoryFactDTO(updated.fact) }
  }
}
