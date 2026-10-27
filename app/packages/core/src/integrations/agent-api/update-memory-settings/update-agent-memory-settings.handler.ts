import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { parseAgentMemorySettings } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { UpdateAgentMemorySettingsRequest } from './update-agent-memory-settings.request'
import {
  UpdateAgentMemorySettingsRequestErrorCode,
  type UpdateAgentMemorySettingsResult,
} from './update-agent-memory-settings.types'

/**
 * `PUT /v1/users/{userId}/memory/settings`. Turning off always works and is idempotent; turning on
 * needs the consent version, the feature on and the person in the beta, if there is one. The agent's
 * refusals are told apart by their code: a 503 `MEMORY_UNAVAILABLE` is an answer, any other 5xx is
 * the agent being down.
 */
@requestHandler(UpdateAgentMemorySettingsRequest)
export class UpdateAgentMemorySettingsRequestHandler implements RequestHandler<
  UpdateAgentMemorySettingsRequest,
  UpdateAgentMemorySettingsResult
> {
  async handle(request: UpdateAgentMemorySettingsRequest): Promise<UpdateAgentMemorySettingsResult> {
    const { status, body, errorCode } = await callAgent<unknown>(
      `${userMemoryPath(request.userId)}/settings`,
      {
        method: 'PUT',
        body: {
          ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
          consentVersion: request.consentVersion,
          ...(request.sensitiveEnabled !== undefined ? { sensitiveEnabled: request.sensitiveEnabled } : {}),
          ...(request.chatSearchEnabled !== undefined ? { chatSearchEnabled: request.chatSearchEnabled } : {}),
        },
        handledErrorCodes: ['MEMORY_UNAVAILABLE'],
      },
    )
    if (status === 200) return { success: true, settings: parseAgentMemorySettings(body) }
    switch (errorCode) {
      case 'MEMORY_UNAVAILABLE':
        return { success: false, error: UpdateAgentMemorySettingsRequestErrorCode.MEMORY_UNAVAILABLE }
      case 'MEMORY_NOT_ALLOWED':
        return { success: false, error: UpdateAgentMemorySettingsRequestErrorCode.MEMORY_NOT_ALLOWED }
      case 'AGENT_VALIDATION':
        // Our input as the agent read it. The same code on a 404 is a route an older agent does not have.
        if (status === 400 || status === 422) {
          return { success: false, error: UpdateAgentMemorySettingsRequestErrorCode.INVALID_REQUEST }
        }
        break
      default:
        break
    }
    throw new Error(`Agent API refused to change memory settings: ${status} ${errorCode ?? ''}`.trim())
  }
}
