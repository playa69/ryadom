import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { ruStorePushConfig } from '../config'
import { SendRuStorePushRequest } from './send-rustore-push.request'
import { SendRuStorePushRequestErrorCode, type SendRuStorePushResponse } from './send-rustore-push.types'

/**
 * RuStore Push mirrors FCM v1: a message with `notification` is shown by the SDK itself, and `data` reaches the app
 * with the tap. Only a `404` tells about the token; every other refusal (`400` for a malformed message, `401`/`403` for
 * the service token, `429`, `5xx`) throws, and the token is kept: those are ours or theirs, not the device's.
 */
@requestHandler(SendRuStorePushRequest)
export class SendRuStorePushRequestHandler implements RequestHandler<
  SendRuStorePushRequest,
  SendRuStorePushResponse
> {
  async handle(request: SendRuStorePushRequest): Promise<SendRuStorePushResponse> {
    const serviceToken = ruStorePushConfig.serviceToken(request.projectId)
    if (serviceToken === null)
      return { success: false, error: SendRuStorePushRequestErrorCode.PROJECT_NOT_CONFIGURED }

    const message = {
      token: request.token,
      notification: { title: request.title, body: request.body },
      ...(Object.keys(request.data).length > 0 ? { data: request.data } : {}),
      android: { ttl: `${ruStorePushConfig.ttlSeconds}s` },
    }
    const response = await fetch(
      `${ruStorePushConfig.baseUrl}/v1/projects/${encodeURIComponent(request.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(ruStorePushConfig.timeoutMs),
      },
    )
    if (response.ok) return { success: true }
    if (response.status === 404)
      return { success: false, error: SendRuStorePushRequestErrorCode.TOKEN_NOT_FOUND }
    // The status word only: the body may echo the message back, and the message is the person's.
    const answer = (await response.json().catch(() => null)) as { error?: { status?: unknown } } | null
    const status = typeof answer?.error?.status === 'string' ? answer.error.status : 'unknown'
    throw new Error(`RuStore Push refused the message: ${response.status} ${status}`)
  }
}
