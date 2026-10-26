import { requestHandler, type RequestHandler } from 'mediatr-ts'
import type { AgentDialogSummaryResponse } from '../shared/agent-api.types'
import { callAgent, userDialogsPath } from '../shared/request'
import { PutAgentRecapRequest } from './put-agent-recap.request'
import { PutAgentRecapRequestErrorCode, type PutAgentRecapResult } from './put-agent-recap.types'

@requestHandler(PutAgentRecapRequest)
export class PutAgentRecapRequestHandler implements RequestHandler<PutAgentRecapRequest, PutAgentRecapResult> {
  async handle(request: PutAgentRecapRequest): Promise<PutAgentRecapResult> {
    const { status, body } = await callAgent<{ summary?: AgentDialogSummaryResponse | null }>(
      `${userDialogsPath(request.userId)}/${encodeURIComponent(request.dialogId)}/recap`,
      {
        method: 'PUT',
        body: { about: request.about, main: request.main, agreements: request.agreements, source: request.source },
      },
    )
    if (status === 404) return { success: false, error: PutAgentRecapRequestErrorCode.DIALOG_NOT_FOUND }
    if (status === 409) return { success: false, error: PutAgentRecapRequestErrorCode.RECAP_NOT_AVAILABLE }
    if (status !== 200) throw new Error(`Agent API refused to save a recap: ${status}`)
    return { success: true, summary: body?.summary ?? null }
  }
}
