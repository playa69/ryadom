import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  agentApiIntegration,
  AgentMemoryInstructionRequest,
  AgentMemoryInstructionRequestErrorCode,
} from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { toMemoryNoteDTO } from '../shared/memory.dto'
import { MemoryInstructionOperation } from './memory-instruction.operation'
import { MemoryInstructionOperationErrorCode, type MemoryInstructionResult } from './memory-instruction.types'

/** The text of the request is the person's own words: it goes to the agent and is never logged. */
@requestHandler(MemoryInstructionOperation)
export class MemoryInstructionOperationHandler implements RequestHandler<
  MemoryInstructionOperation,
  MemoryInstructionResult
> {
  async handle(operation: MemoryInstructionOperation): Promise<MemoryInstructionResult> {
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: MemoryInstructionOperationErrorCode.USER_NOT_FOUND }
    }
    const done = await agentApiIntegration.execute(
      new AgentMemoryInstructionRequest({ userId: operation.userId, text: operation.text }),
    )
    if (!done.success) {
      switch (done.error) {
        case AgentMemoryInstructionRequestErrorCode.MEMORY_DISABLED:
          return { success: false, error: MemoryInstructionOperationErrorCode.MEMORY_DISABLED }
        case AgentMemoryInstructionRequestErrorCode.MEMORY_UNAVAILABLE:
          return { success: false, error: MemoryInstructionOperationErrorCode.MEMORY_UNAVAILABLE }
        default:
          return assertNever(done.error)
      }
    }
    createLogger('memory').info('Memory instruction carried out', {
      userId: operation.userId,
      added: done.changes.added.length,
      updated: done.changes.updated.length,
      deleted: done.changes.deleted.length,
      blocked: done.changes.blocked,
    })
    return {
      success: true,
      changes: {
        added: done.changes.added.map(toMemoryNoteDTO),
        updated: done.changes.updated.map(toMemoryNoteDTO),
        deleted: done.changes.deleted,
        blocked: done.changes.blocked,
      },
    }
  }
}
