import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent, userMemoryPath } from '../shared/request'
import { ForgetAgentMemoryRequest } from './forget-agent-memory.request'
import { ForgetAgentMemoryRequestErrorCode, type ForgetAgentMemoryResult } from './forget-agent-memory.types'

/**
 * `DELETE /v1/users/{userId}/memory`, idempotent. Anything but `204` (or `MEMORY_UNAVAILABLE`)
 * throws: memory cannot be declared forgotten until the agent has confirmed it.
 */
@requestHandler(ForgetAgentMemoryRequest)
export class ForgetAgentMemoryRequestHandler implements RequestHandler<
  ForgetAgentMemoryRequest,
  ForgetAgentMemoryResult
> {
  async handle(request: ForgetAgentMemoryRequest): Promise<ForgetAgentMemoryResult> {
    const { status, errorCode } = await callAgent(userMemoryPath(request.userId), {
      method: 'DELETE',
      handledErrorCodes: ['MEMORY_UNAVAILABLE'],
    })
    if (status === 204 || status === 200) return { success: true }
    if (errorCode === 'MEMORY_UNAVAILABLE') {
      return { success: false, error: ForgetAgentMemoryRequestErrorCode.MEMORY_UNAVAILABLE }
    }
    throw new Error(`Agent API refused to forget memory: ${status} ${errorCode ?? ''}`.trim())
  }
}
