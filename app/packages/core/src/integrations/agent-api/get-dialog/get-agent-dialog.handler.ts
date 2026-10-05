import { requestHandler, type RequestHandler } from 'mediatr-ts'
import type { AgentDialogResponse } from '../shared/agent-api.types'
import { callAgent, userDialogsPath } from '../shared/request'
import { GetAgentDialogRequest } from './get-agent-dialog.request'
import { GetAgentDialogRequestErrorCode, type GetAgentDialogResult } from './get-agent-dialog.types'

/**
 * `GET /v1/users/{userId}/dialogs/{dialogId}`: a dialog with its messages. The path carries the
 * user because the agent, not us, checks that the dialog belongs to them.
 */
@requestHandler(GetAgentDialogRequest)
export class GetAgentDialogRequestHandler
  implements RequestHandler<GetAgentDialogRequest, GetAgentDialogResult>
{
  async handle(request: GetAgentDialogRequest): Promise<GetAgentDialogResult> {
    const { status, body } = await callAgent<AgentDialogResponse>(
      `${userDialogsPath(request.userId)}/${encodeURIComponent(request.dialogId)}`,
    )
    if (status === 404) return { success: false, error: GetAgentDialogRequestErrorCode.DIALOG_NOT_FOUND }
    if (status !== 200 || !body) throw new Error(`Agent API refused to return a dialog: ${status}`)
    return { success: true, dialog: { ...body, messages: Array.isArray(body.messages) ? body.messages : [] } }
  }
}
