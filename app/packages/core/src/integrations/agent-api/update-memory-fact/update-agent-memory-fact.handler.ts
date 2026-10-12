import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { parseAgentMemoryFactOrThrow, rejectionReasonOf } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { UpdateAgentMemoryFactRequest } from './update-agent-memory-fact.request'
import {
  UpdateAgentMemoryFactRequestErrorCode,
  type UpdateAgentMemoryFactResult,
} from './update-agent-memory-fact.types'

/**
 * `PATCH /v1/users/{userId}/memory/facts/{factId}`. Only the fields that were given travel; the
 * path carries the person, so a fact of someone else is a `FACT_NOT_FOUND` like a missing one.
 */
@requestHandler(UpdateAgentMemoryFactRequest)
export class UpdateAgentMemoryFactRequestHandler implements RequestHandler<
  UpdateAgentMemoryFactRequest,
  UpdateAgentMemoryFactResult
> {
  async handle(request: UpdateAgentMemoryFactRequest): Promise<UpdateAgentMemoryFactResult> {
    const payload: Record<string, unknown> = {}
    if (request.text !== undefined) payload.text = request.text
    if (request.slots !== undefined) payload.slots = request.slots
    if (request.status !== undefined) payload.status = request.status
    if (request.confirm !== undefined) payload.confirm = request.confirm
    const { status, body, errorCode, errorDetails } = await callAgent<unknown>(
      `${userMemoryPath(request.userId)}/facts/${encodeURIComponent(request.factId)}`,
      { method: 'PATCH', body: payload, handledErrorCodes: ['MEMORY_UNAVAILABLE'] },
    )
    if (status === 200) return { success: true, fact: parseAgentMemoryFactOrThrow(body) }
    switch (errorCode) {
      case 'FACT_NOT_FOUND':
        return { success: false, error: UpdateAgentMemoryFactRequestErrorCode.FACT_NOT_FOUND }
      case 'MEMORY_DISABLED':
        return { success: false, error: UpdateAgentMemoryFactRequestErrorCode.MEMORY_DISABLED }
      case 'FACT_REJECTED':
        return {
          success: false,
          error: UpdateAgentMemoryFactRequestErrorCode.FACT_REJECTED,
          reason: rejectionReasonOf(errorDetails),
        }
      case 'MEMORY_UNAVAILABLE':
        return { success: false, error: UpdateAgentMemoryFactRequestErrorCode.MEMORY_UNAVAILABLE }
      case 'AGENT_VALIDATION':
        // Our input as the agent read it. The same code on a 404 is a route an older agent does not have.
        if (status === 400 || status === 422) {
          return { success: false, error: UpdateAgentMemoryFactRequestErrorCode.INVALID_REQUEST }
        }
        break
      default:
        break
    }
    throw new Error(`Agent API refused to change a memory fact: ${status} ${errorCode ?? ''}`.trim())
  }
}
