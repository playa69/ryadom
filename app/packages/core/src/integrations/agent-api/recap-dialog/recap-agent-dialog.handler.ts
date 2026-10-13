import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent, userDialogsPath } from '../shared/request'
import { RecapAgentDialogRequest } from './recap-agent-dialog.request'
import { RecapAgentDialogRequestErrorCode, type RecapAgentDialogResult } from './recap-agent-dialog.types'

/** `POST /v1/users/{userId}/dialogs/{dialogId}/recap`: what the talk was about and where it got to. Changes nothing. */
@requestHandler(RecapAgentDialogRequest)
export class RecapAgentDialogRequestHandler implements RequestHandler<
  RecapAgentDialogRequest,
  RecapAgentDialogResult
> {
  async handle(request: RecapAgentDialogRequest): Promise<RecapAgentDialogResult> {
    const { status, body } = await callAgent<{ recap?: string | null }>(
      `${userDialogsPath(request.userId)}/${encodeURIComponent(request.dialogId)}/recap`,
      { method: 'POST' },
    )
    if (status === 404) return { success: false, error: RecapAgentDialogRequestErrorCode.DIALOG_NOT_FOUND }
    if (status !== 200) throw new Error(`Agent API refused a dialog recap: ${status}`)
    const recap = typeof body?.recap === 'string' && body.recap.trim() !== '' ? body.recap : null
    return { success: true, recap }
  }
}
