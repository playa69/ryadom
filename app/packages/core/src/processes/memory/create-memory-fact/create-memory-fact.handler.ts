import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, validateInput } from '../../../shared'
import {
  agentApiIntegration,
  CreateAgentMemoryFactRequest,
  CreateAgentMemoryFactRequestErrorCode,
} from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { toMemoryFactDTO } from '../shared/memory.dto'
import { CreateMemoryFactOperation } from './create-memory-fact.operation'
import { CreateMemoryFactOperationErrorCode, type CreateMemoryFactResult } from './create-memory-fact.types'
import { createMemoryFactSchema } from './create-memory-fact.validator'

/**
 * The person writes a fact themselves. What may be remembered is decided by the agent's rules, the
 * same that guard what it extracts on its own, so a refusal comes back with the code of the rule.
 */
@requestHandler(CreateMemoryFactOperation)
export class CreateMemoryFactOperationHandler implements RequestHandler<
  CreateMemoryFactOperation,
  CreateMemoryFactResult
> {
  async handle(operation: CreateMemoryFactOperation): Promise<CreateMemoryFactResult> {
    const input = validateInput(createMemoryFactSchema, { text: operation.text })
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: CreateMemoryFactOperationErrorCode.USER_NOT_FOUND }
    }
    const created = await agentApiIntegration.execute(
      new CreateAgentMemoryFactRequest({
        userId: operation.userId,
        category: operation.category,
        text: input.text,
        slots: operation.slots,
      }),
    )
    if (!created.success) {
      switch (created.error) {
        case CreateAgentMemoryFactRequestErrorCode.MEMORY_DISABLED:
          return { success: false, error: CreateMemoryFactOperationErrorCode.MEMORY_DISABLED }
        case CreateAgentMemoryFactRequestErrorCode.MEMORY_FULL:
          return { success: false, error: CreateMemoryFactOperationErrorCode.MEMORY_FULL }
        case CreateAgentMemoryFactRequestErrorCode.FACT_REJECTED:
          createLogger('memory').info('Memory fact refused by the rules', {
            userId: operation.userId,
            category: operation.category,
            reason: created.reason,
          })
          return {
            success: false,
            error: CreateMemoryFactOperationErrorCode.FACT_REJECTED,
            reason: created.reason,
          }
        case CreateAgentMemoryFactRequestErrorCode.MEMORY_UNAVAILABLE:
          return { success: false, error: CreateMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE }
        case CreateAgentMemoryFactRequestErrorCode.INVALID_REQUEST:
          return { success: false, error: CreateMemoryFactOperationErrorCode.INVALID_FACT }
        default:
          return assertNever(created)
      }
    }
    createLogger('memory').info('Memory fact written by the person', {
      userId: operation.userId,
      factId: created.fact.id,
      category: created.fact.category,
    })
    return { success: true, fact: toMemoryFactDTO(created.fact) }
  }
}
