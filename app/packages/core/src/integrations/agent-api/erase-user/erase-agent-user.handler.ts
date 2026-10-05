import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent } from '../shared/request'
import { EraseAgentUserRequest } from './erase-agent-user.request'
import type { EraseAgentUserResponse } from './erase-agent-user.types'

/**
 * `DELETE /v1/users/{userId}`, idempotent. A 404 counts as success: there was nothing to erase and
 * the result is the one that was asked for. Any other non-2xx throws, because the data cannot be
 * declared erased until the agent has confirmed it.
 */
@requestHandler(EraseAgentUserRequest)
export class EraseAgentUserRequestHandler
  implements RequestHandler<EraseAgentUserRequest, EraseAgentUserResponse>
{
  async handle(request: EraseAgentUserRequest): Promise<EraseAgentUserResponse> {
    const { status } = await callAgent(`/v1/users/${encodeURIComponent(request.userId)}`, { method: 'DELETE' })
    if (status === 204 || status === 200 || status === 404) return { erased: true }
    throw new Error(`Agent API refused to erase the user: ${status}`)
  }
}
