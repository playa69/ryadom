import { requestHandler, type RequestHandler } from 'mediatr-ts'
import type { AgentDialogSummaryResponse } from '../shared/agent-api.types'
import { callAgent, userDialogsPath } from '../shared/request'
import { EndAgentDialogRequest } from './end-agent-dialog.request'
import { EndAgentDialogRequestErrorCode, type EndAgentDialogResult } from './end-agent-dialog.types'

/** `POST /v1/users/{userId}/dialogs/{dialogId}/end`: end the dialog and get the summary. */
@requestHandler(EndAgentDialogRequest)
export class EndAgentDialogRequestHandler
  implements RequestHandler<EndAgentDialogRequest, EndAgentDialogResult>
{
  async handle(request: EndAgentDialogRequest): Promise<EndAgentDialogResult> {
    const body: Record<string, unknown> = {}
    if (request.takeaway !== null) body.takeaway = request.takeaway
    if (request.tensionAfter !== null) body.tensionAfter = request.tensionAfter
    if (request.recapSource === 'draft') body.recapSource = 'draft'

    const { status, body: response } = await callAgent<{ summary?: AgentDialogSummaryResponse | null; saved?: boolean }>(
      `${userDialogsPath(request.userId)}/${encodeURIComponent(request.dialogId)}/end`,
      { method: 'POST', body },
    )
    if (status === 404) return { success: false, error: EndAgentDialogRequestErrorCode.DIALOG_NOT_FOUND }
    if (status !== 200) throw new Error(`Agent API refused to end a dialog: ${status}`)
    // `saved: false`: the dialog was held unsaved; an agent that does not say it saved everything.
    return { success: true, summary: response?.summary ?? null, saved: response?.saved !== false }
  }
}
