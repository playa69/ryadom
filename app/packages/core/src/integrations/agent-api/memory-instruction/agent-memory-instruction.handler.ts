import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { z } from 'zod'
import { parseNotesList } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { AgentMemoryInstructionRequest } from './agent-memory-instruction.request'
import {
  AgentMemoryInstructionRequestErrorCode,
  type AgentMemoryInstructionResult,
} from './agent-memory-instruction.types'

const changesSchema = z.object({
  changes: z.object({
    added: z.array(z.unknown()).catch([]),
    updated: z.array(z.unknown()).catch([]),
    deleted: z.array(z.string()).catch([]),
    blocked: z.array(z.string()).catch([]),
  }),
})

/**
 * `POST /v1/users/{userId}/memory/notes/instruction`. The agent carries the request out with its model; a
 * `MEMORY_UNAVAILABLE` (503) means it has none right now, which is an answer, not the agent being down.
 */
@requestHandler(AgentMemoryInstructionRequest)
export class AgentMemoryInstructionRequestHandler implements RequestHandler<
  AgentMemoryInstructionRequest,
  AgentMemoryInstructionResult
> {
  async handle(request: AgentMemoryInstructionRequest): Promise<AgentMemoryInstructionResult> {
    const { status, body, errorCode } = await callAgent<unknown>(
      `${userMemoryPath(request.userId)}/notes/instruction`,
      { method: 'POST', body: { text: request.text }, handledErrorCodes: ['MEMORY_UNAVAILABLE'] },
    )
    if (status === 200) {
      const parsed = changesSchema.safeParse(body)
      if (!parsed.success) throw new Error('Agent API returned a malformed memory instruction answer')
      const { added, updated, deleted, blocked } = parsed.data.changes
      return {
        success: true,
        changes: { added: parseNotesList(added), updated: parseNotesList(updated), deleted, blocked },
      }
    }
    switch (errorCode) {
      case 'MEMORY_DISABLED':
        return { success: false, error: AgentMemoryInstructionRequestErrorCode.MEMORY_DISABLED }
      case 'MEMORY_UNAVAILABLE':
        return { success: false, error: AgentMemoryInstructionRequestErrorCode.MEMORY_UNAVAILABLE }
      default:
        break
    }
    throw new Error(`Agent API refused a memory instruction: ${status} ${errorCode ?? ''}`.trim())
  }
}
