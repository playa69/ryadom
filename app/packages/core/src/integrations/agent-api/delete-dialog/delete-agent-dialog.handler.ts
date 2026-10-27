import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent, userDialogsPath } from '../shared/request'
import { DeleteAgentDialogRequest } from './delete-agent-dialog.request'
import { DeleteAgentDialogRequestErrorCode, type DeleteAgentDialogResult } from './delete-agent-dialog.types'

@requestHandler(DeleteAgentDialogRequest)
export class DeleteAgentDialogRequestHandler implements RequestHandler<DeleteAgentDialogRequest, DeleteAgentDialogResult> {
  async handle(request: DeleteAgentDialogRequest): Promise<DeleteAgentDialogResult> {
    const { status } = await callAgent<unknown>(`${userDialogsPath(request.userId)}/${encodeURIComponent(request.dialogId)}`, {
      method: 'DELETE',
    })
    if (status === 404) return { success: false, error: DeleteAgentDialogRequestErrorCode.DIALOG_NOT_FOUND }
    if (status !== 204 && status !== 200) throw new Error(`Agent API refused to delete a dialog: ${status}`)
    return { success: true }
  }
}
