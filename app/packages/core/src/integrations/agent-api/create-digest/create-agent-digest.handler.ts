import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent } from '../shared/request'
import { CreateAgentDigestRequest } from './create-agent-digest.request'
import { CreateAgentDigestRequestErrorCode, type CreateAgentDigestResult } from './create-agent-digest.types'

/** `POST /v1/users/{userId}/digests` → `{ text, stats }`. A down agent throws `AgentUnavailableError` like every call. */
@requestHandler(CreateAgentDigestRequest)
export class CreateAgentDigestRequestHandler implements RequestHandler<CreateAgentDigestRequest, CreateAgentDigestResult> {
  async handle(request: CreateAgentDigestRequest): Promise<CreateAgentDigestResult> {
    const { status, body } = await callAgent<{ text?: unknown; stats?: unknown }>(
      `/v1/users/${encodeURIComponent(request.userId)}/digests`,
      {
        method: 'POST',
        body: {
          kind: request.kind,
          periodStart: request.periodStart,
          marks: request.marks,
        },
      },
    )
    if (status !== 200 || typeof body?.text !== 'string' || body.text.trim() === '') {
      return { success: false, error: CreateAgentDigestRequestErrorCode.UNAVAILABLE }
    }
    const stats = typeof body.stats === 'object' && body.stats !== null ? (body.stats as Record<string, unknown>) : null
    return { success: true, text: body.text.trim(), stats }
  }
}
