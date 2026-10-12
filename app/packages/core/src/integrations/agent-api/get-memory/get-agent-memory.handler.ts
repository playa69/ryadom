import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { parseAgentMemory } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { GetAgentMemoryRequest } from './get-agent-memory.request'
import type { GetAgentMemoryResponse } from './get-agent-memory.types'

/**
 * `GET /v1/users/{userId}/memory`. It answers in any mode and with the person's memory off: reading
 * what is remembered is always allowed, `available: false` says the feature itself is off.
 */
@requestHandler(GetAgentMemoryRequest)
export class GetAgentMemoryRequestHandler implements RequestHandler<
  GetAgentMemoryRequest,
  GetAgentMemoryResponse
> {
  async handle(request: GetAgentMemoryRequest): Promise<GetAgentMemoryResponse> {
    const { status, body, errorCode } = await callAgent<unknown>(userMemoryPath(request.userId))
    if (status !== 200)
      throw new Error(`Agent API refused to return memory: ${status} ${errorCode ?? ''}`.trim())
    return parseAgentMemory(body)
  }
}
