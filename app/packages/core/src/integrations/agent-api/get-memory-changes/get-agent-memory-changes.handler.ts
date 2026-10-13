import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { parseAgentMemoryChanges } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { GetAgentMemoryChangesRequest } from './get-agent-memory-changes.request'
import {
  GetAgentMemoryChangesRequestErrorCode,
  type GetAgentMemoryChangesResult,
} from './get-agent-memory-changes.types'

/**
 * `GET /v1/users/{userId}/memory/changes?dialogId=`. The path carries the person, so the agent
 * answers `AGENT_DIALOG_NOT_FOUND` for a dialog of someone else as for a missing one.
 */
@requestHandler(GetAgentMemoryChangesRequest)
export class GetAgentMemoryChangesRequestHandler implements RequestHandler<
  GetAgentMemoryChangesRequest,
  GetAgentMemoryChangesResult
> {
  async handle(request: GetAgentMemoryChangesRequest): Promise<GetAgentMemoryChangesResult> {
    const params = new URLSearchParams({ dialogId: request.dialogId })
    const { status, body, errorCode } = await callAgent<unknown>(
      `${userMemoryPath(request.userId)}/changes?${params.toString()}`,
    )
    if (status === 200) return { success: true, changes: parseAgentMemoryChanges(body) }
    if (errorCode === 'AGENT_DIALOG_NOT_FOUND') {
      return { success: false, error: GetAgentMemoryChangesRequestErrorCode.DIALOG_NOT_FOUND }
    }
    throw new Error(`Agent API refused to return memory changes: ${status} ${errorCode ?? ''}`.trim())
  }
}
