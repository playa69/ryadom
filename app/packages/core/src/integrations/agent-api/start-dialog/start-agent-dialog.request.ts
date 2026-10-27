import { RequestData } from 'mediatr-ts'
import type { AgentVoice } from '@ryadom/db/schema'
import type { AgentDialogMemoryMode } from '../shared/agent-memory.types'
import type { StartAgentDialogResponse } from './start-agent-dialog.types'

export interface StartAgentDialogRequestData {
  userId: string
  /** The voice the agent speaks with in this dialog; without it the agent keeps the person's last choice. */
  voice?: AgentVoice
  /** The concrete voice (a Gemini voice name) the person picked; the agent applies it on top of the gender. */
  voiceName?: string
  /**
   * Ask for a fresh dialog: the agent ends the person's open one (an empty one is just reused) and
   * starts another, so the answer is never `resumed`. Without it the start changes nothing and
   * returns the open dialog.
   */
  startNew?: boolean
  /**
   * `off` holds a new dialog "without memory"; only a new dialog takes it, a returned open one keeps
   * its own. Without it the agent's default (`on`) applies.
   */
  memory?: AgentDialogMemoryMode
}

export class StartAgentDialogRequest extends RequestData<StartAgentDialogResponse> {
  /** Survives build minification: StartAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'StartAgentDialogRequest'

  public readonly userId: string
  public readonly voice: AgentVoice | undefined
  public readonly voiceName: string | undefined
  public readonly startNew: boolean
  public readonly memory: AgentDialogMemoryMode | undefined

  constructor(data: StartAgentDialogRequestData) {
    super()
    this.userId = data.userId
    this.voice = data.voice
    this.voiceName = data.voiceName
    this.startNew = data.startNew === true
    this.memory = data.memory
  }
}
