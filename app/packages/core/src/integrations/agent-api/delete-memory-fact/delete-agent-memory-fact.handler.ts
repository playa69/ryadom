import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent, userMemoryPath } from '../shared/request'
import { DeleteAgentMemoryFactRequest } from './delete-agent-memory-fact.request'
import {
  DeleteAgentMemoryFactRequestErrorCode,
  type DeleteAgentMemoryFactResult,
} from './delete-agent-memory-fact.types'

/**
 * `DELETE /v1/users/{userId}/memory/notes/{noteId}`, idempotent: `204`, and a `404` counts as done
 * too, since what was asked for (the note is gone) holds. Anything else throws: a note cannot be
 * declared forgotten until the agent has confirmed it.
 */
@requestHandler(DeleteAgentMemoryFactRequest)
export class DeleteAgentMemoryFactRequestHandler implements RequestHandler<
  DeleteAgentMemoryFactRequest,
  DeleteAgentMemoryFactResult
> {
  async handle(request: DeleteAgentMemoryFactRequest): Promise<DeleteAgentMemoryFactResult> {
    const { status, errorCode } = await callAgent(
      `${userMemoryPath(request.userId)}/notes/${encodeURIComponent(request.factId)}`,
      { method: 'DELETE', handledErrorCodes: ['MEMORY_UNAVAILABLE'] },
    )
    if (status === 204 || status === 200 || status === 404) return { success: true }
    if (errorCode === 'MEMORY_UNAVAILABLE') {
      return { success: false, error: DeleteAgentMemoryFactRequestErrorCode.MEMORY_UNAVAILABLE }
    }
    throw new Error(`Agent API refused to forget a memory note: ${status} ${errorCode ?? ''}`.trim())
  }
}
