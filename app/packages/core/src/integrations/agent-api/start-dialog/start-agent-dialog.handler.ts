import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent, userDialogsPath } from '../shared/request'
import { StartAgentDialogRequest } from './start-agent-dialog.request'
import type { StartAgentDialogResponse } from './start-agent-dialog.types'

interface RawStart {
  dialogId?: unknown
  resumed?: unknown
  greeting?: unknown
  sinceLastDialogHours?: unknown
}

/**
 * `POST /v1/users/{userId}/dialogs`: start a dialog or get the one already open. The body is
 * optional and carries only the voice the person picked (`{ voice }`); without one the agent keeps
 * the person's last choice.
 */
@requestHandler(StartAgentDialogRequest)
export class StartAgentDialogRequestHandler implements RequestHandler<
  StartAgentDialogRequest,
  StartAgentDialogResponse
> {
  async handle(request: StartAgentDialogRequest): Promise<StartAgentDialogResponse> {
    const { status, body } = await callAgent<RawStart>(userDialogsPath(request.userId), {
      method: 'POST',
      body: request.voice ? { voice: request.voice } : undefined,
    })
    if (status !== 200 && status !== 201) throw new Error(`Agent API refused to start a dialog: ${status}`)
    if (!body || typeof body.dialogId !== 'string' || !body.dialogId) {
      throw new Error('Agent API did not return dialogId')
    }
    return {
      dialogId: body.dialogId,
      resumed: body.resumed === true,
      greeting: typeof body.greeting === 'string' ? body.greeting : null,
      sinceLastDialogHours: typeof body.sinceLastDialogHours === 'number' ? body.sinceLastDialogHours : null,
    }
  }
}
