import { RequestData } from 'mediatr-ts'
import type { AgentVoice } from '@ryadom/db/schema'
import type { StartAgentDialogResponse } from './start-agent-dialog.types'

export interface StartAgentDialogRequestData {
  userId: string
  /** The voice the agent speaks with in this dialog; without it the agent keeps the person's last choice. */
  voice?: AgentVoice
  /**
   * Ask for a fresh dialog: the agent ends the person's open one (an empty one is just reused) and
   * starts another, so the answer is never `resumed`. Without it the start changes nothing and
   * returns the open dialog.
   */
  startNew?: boolean
}

export class StartAgentDialogRequest extends RequestData<StartAgentDialogResponse> {
  /** Survives build minification: StartAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'StartAgentDialogRequest'

  public readonly userId: string
  public readonly voice: AgentVoice | undefined
  public readonly startNew: boolean

  constructor(data: StartAgentDialogRequestData) {
    super()
    this.userId = data.userId
    this.voice = data.voice
    this.startNew = data.startNew === true
  }
}
