import { requestHandler, type RequestHandler } from 'mediatr-ts'
import type { AgentRecapResponse } from '../shared/agent-api.types'
import { callAgent, userDialogsPath } from '../shared/request'
import { DraftAgentRecapRequest } from './draft-agent-recap.request'
import { DraftAgentRecapRequestErrorCode, type DraftAgentRecapResult } from './draft-agent-recap.types'

@requestHandler(DraftAgentRecapRequest)
export class DraftAgentRecapRequestHandler implements RequestHandler<DraftAgentRecapRequest, DraftAgentRecapResult> {
  async handle(request: DraftAgentRecapRequest): Promise<DraftAgentRecapResult> {
    const { status, body, errorCode } = await callAgent<{ recap?: AgentRecapResponse }>(
      `${userDialogsPath(request.userId)}/${encodeURIComponent(request.dialogId)}/recap/draft`,
      { method: 'POST', body: {}, handledErrorCodes: ['RECAP_UNAVAILABLE'] },
    )
    if (status === 404) return { success: false, error: DraftAgentRecapRequestErrorCode.DIALOG_NOT_FOUND }
    if (status === 409) return { success: false, error: DraftAgentRecapRequestErrorCode.RECAP_NOT_AVAILABLE }
    if (status === 502 || errorCode === 'RECAP_UNAVAILABLE') return { success: false, error: DraftAgentRecapRequestErrorCode.UNAVAILABLE }
    if (status !== 200 || !body?.recap) throw new Error(`Agent API refused to draft a recap: ${status}`)
    return { success: true, recap: body.recap }
  }
}
