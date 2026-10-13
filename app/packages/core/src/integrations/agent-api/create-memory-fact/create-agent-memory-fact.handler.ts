import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { parseAgentMemoryFactOrThrow, rejectionReasonOf } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { CreateAgentMemoryFactRequest } from './create-agent-memory-fact.request'
import {
  CreateAgentMemoryFactRequestErrorCode,
  type CreateAgentMemoryFactResult,
} from './create-agent-memory-fact.types'

/** `POST /v1/users/{userId}/memory/facts`: `201` with the fact, or a refusal told apart by its code. */
@requestHandler(CreateAgentMemoryFactRequest)
export class CreateAgentMemoryFactRequestHandler implements RequestHandler<
  CreateAgentMemoryFactRequest,
  CreateAgentMemoryFactResult
> {
  async handle(request: CreateAgentMemoryFactRequest): Promise<CreateAgentMemoryFactResult> {
    const payload: Record<string, unknown> = { category: request.category }
    if (request.text !== null) payload.text = request.text
    if (request.slots !== null) payload.slots = request.slots
    const { status, body, errorCode, errorDetails } = await callAgent<unknown>(
      `${userMemoryPath(request.userId)}/facts`,
      { method: 'POST', body: payload, handledErrorCodes: ['MEMORY_UNAVAILABLE'] },
    )
    if (status === 200 || status === 201) return { success: true, fact: parseAgentMemoryFactOrThrow(body) }
    switch (errorCode) {
      case 'MEMORY_DISABLED':
        return { success: false, error: CreateAgentMemoryFactRequestErrorCode.MEMORY_DISABLED }
      case 'MEMORY_FULL':
        return { success: false, error: CreateAgentMemoryFactRequestErrorCode.MEMORY_FULL }
      case 'FACT_REJECTED':
        return {
          success: false,
          error: CreateAgentMemoryFactRequestErrorCode.FACT_REJECTED,
          reason: rejectionReasonOf(errorDetails),
        }
      case 'MEMORY_UNAVAILABLE':
        return { success: false, error: CreateAgentMemoryFactRequestErrorCode.MEMORY_UNAVAILABLE }
      case 'AGENT_VALIDATION':
        // Our input as the agent read it. The same code on a 404 is a route an older agent does not have.
        if (status === 400 || status === 422) {
          return { success: false, error: CreateAgentMemoryFactRequestErrorCode.INVALID_REQUEST }
        }
        break
      default:
        break
    }
    throw new Error(`Agent API refused to add a memory fact: ${status} ${errorCode ?? ''}`.trim())
  }
}
