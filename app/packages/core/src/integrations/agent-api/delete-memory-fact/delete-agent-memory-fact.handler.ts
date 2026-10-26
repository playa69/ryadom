import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { rejectionReasonOf } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { DeleteAgentMemoryFactRequest } from './delete-agent-memory-fact.request'
import {
  DeleteAgentMemoryFactRequestErrorCode,
  type DeleteAgentMemoryFactResult,
} from './delete-agent-memory-fact.types'

/**
 * `DELETE /v1/users/{userId}/memory/facts/{factId}`, idempotent: `204`, and a `404` counts as done
 * too, since what was asked for (the fact is gone) holds. Anything else throws: a fact cannot be
 * declared forgotten until the agent has confirmed it.
 */
@requestHandler(DeleteAgentMemoryFactRequest)
export class DeleteAgentMemoryFactRequestHandler implements RequestHandler<
  DeleteAgentMemoryFactRequest,
  DeleteAgentMemoryFactResult
> {
  async handle(request: DeleteAgentMemoryFactRequest): Promise<DeleteAgentMemoryFactResult> {
    const { status, errorCode, errorDetails } = await callAgent(
      `${userMemoryPath(request.userId)}/facts/${encodeURIComponent(request.factId)}`,
      { method: 'DELETE', handledErrorCodes: ['MEMORY_UNAVAILABLE'] },
    )
    if (status === 204 || status === 200 || status === 404) return { success: true }
    if (errorCode === 'MEMORY_UNAVAILABLE') {
      return { success: false, error: DeleteAgentMemoryFactRequestErrorCode.MEMORY_UNAVAILABLE }
    }
    // The agent on Cognee keeps no single facts: it answers 422 with a reason code, which is not our failure.
    if (status === 422 && errorCode === 'AGENT_VALIDATION' && rejectionReasonOf(errorDetails) === 'unsupported_in_cognee') {
      return { success: false, error: DeleteAgentMemoryFactRequestErrorCode.UNSUPPORTED }
    }
    throw new Error(`Agent API refused to forget a memory fact: ${status} ${errorCode ?? ''}`.trim())
  }
}
