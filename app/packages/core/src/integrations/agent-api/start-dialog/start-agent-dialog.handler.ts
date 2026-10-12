import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent, userDialogsPath } from '../shared/request'
import { StartAgentDialogRequest } from './start-agent-dialog.request'
import type { StartAgentDialogResponse } from './start-agent-dialog.types'

interface RawStart {
  dialogId?: unknown
  resumed?: unknown
  greeting?: unknown
  sinceLastDialogHours?: unknown
  messageCount?: unknown
  lastActivityAt?: unknown
}

/**
 * `POST /v1/users/{userId}/dialogs`: start a dialog or get the one already open. The body is optional
 * and carries the voice the person picked (`{ voice }`; without one the agent keeps the person's last
 * choice) and `new: true` when a fresh dialog is asked for. Without `new` the call changes nothing: the
 * open dialog comes back as it is, with how many messages it holds and when it last moved, so the app
 * can ask the person what to do with it. With `new: true` the agent ends the open dialog (an empty one
 * is just reused) and starts another. With neither field there is no body.
 */
@requestHandler(StartAgentDialogRequest)
export class StartAgentDialogRequestHandler implements RequestHandler<
  StartAgentDialogRequest,
  StartAgentDialogResponse
> {
  async handle(request: StartAgentDialogRequest): Promise<StartAgentDialogResponse> {
    const payload = {
      ...(request.voice ? { voice: request.voice } : {}),
      ...(request.startNew ? { new: true } : {}),
    }
    const { status, body } = await callAgent<RawStart>(userDialogsPath(request.userId), {
      method: 'POST',
      body: Object.keys(payload).length > 0 ? payload : undefined,
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
      // An agent that does not report them (an older one) is read as "nothing to ask about".
      messageCount:
        typeof body.messageCount === 'number' && Number.isFinite(body.messageCount) && body.messageCount > 0
          ? Math.floor(body.messageCount)
          : 0,
      lastActivityAt:
        typeof body.lastActivityAt === 'string' && body.lastActivityAt ? body.lastActivityAt : null,
    }
  }
}
