import { RequestData } from 'mediatr-ts'
import type { AgentVoice } from '@ryadom/db/schema'
import type { StartAgentDialogResponse } from './start-agent-dialog.types'

export interface StartAgentDialogRequestData {
  userId: string
  /** The voice the agent speaks with in this dialog; without it the agent keeps the person's last choice. */
  voice?: AgentVoice
}

export class StartAgentDialogRequest extends RequestData<StartAgentDialogResponse> {
  /** Survives build minification: StartAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'StartAgentDialogRequest'

  public readonly userId: string
  public readonly voice: AgentVoice | undefined

  constructor(data: StartAgentDialogRequestData) {
    super()
    this.userId = data.userId
    this.voice = data.voice
  }
}
