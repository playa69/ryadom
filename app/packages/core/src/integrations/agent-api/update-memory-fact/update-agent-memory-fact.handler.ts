import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { agentNoteAsFact, parseAgentMemoryNoteOrThrow, rejectionReasonOf } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { UpdateAgentMemoryFactRequest } from './update-agent-memory-fact.request'
import {
  UpdateAgentMemoryFactRequestErrorCode,
  type UpdateAgentMemoryFactResult,
} from './update-agent-memory-fact.types'

/**
 * `PATCH /v1/users/{userId}/memory/notes/{noteId}`. The path carries the person, so a note of
 * someone else is a `NOTE_NOT_FOUND` like a missing one. The note comes back in the shape of a fact:
 * the route of the apps is still `/api/memory/facts/:id`, and the clients that predate notes read that shape.
 */
@requestHandler(UpdateAgentMemoryFactRequest)
export class UpdateAgentMemoryFactRequestHandler implements RequestHandler<
  UpdateAgentMemoryFactRequest,
  UpdateAgentMemoryFactResult
> {
  async handle(request: UpdateAgentMemoryFactRequest): Promise<UpdateAgentMemoryFactResult> {
    const { status, body, errorCode, errorDetails } = await callAgent<unknown>(
      `${userMemoryPath(request.userId)}/notes/${encodeURIComponent(request.factId)}`,
      { method: 'PATCH', body: { text: request.text }, handledErrorCodes: ['MEMORY_UNAVAILABLE'] },
    )
    if (status === 200) return { success: true, fact: agentNoteAsFact(parseAgentMemoryNoteOrThrow(body)) }
    switch (errorCode) {
      case 'NOTE_NOT_FOUND':
        return { success: false, error: UpdateAgentMemoryFactRequestErrorCode.FACT_NOT_FOUND }
      case 'NOTE_REJECTED':
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
    throw new Error(`Agent API refused to change a memory note: ${status} ${errorCode ?? ''}`.trim())
  }
}
