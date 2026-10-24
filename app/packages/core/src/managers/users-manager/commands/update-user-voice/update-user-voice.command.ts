import { RequestData } from 'mediatr-ts'
import type { AgentVoice } from '@ryadom/db/schema'
import type { UpdateUserVoiceCommandResult } from './update-user-voice.types'

export interface UpdateUserVoiceCommandData {
  userId: string
  voice: AgentVoice
  /** The concrete voice (a Gemini voice name); `null` goes back to the default voice of the gender. */
  voiceName?: string | null
}

/** Sets the voice the agent speaks with (the gender and, when the person picked one, the concrete voice). It reaches the agent when the next conversation starts. */
export class UpdateUserVoiceCommand extends RequestData<UpdateUserVoiceCommandResult> {
  static readonly requestName = 'UpdateUserVoiceCommand'

  public readonly userId: string
  public readonly voice: AgentVoice
  public readonly voiceName: string | null

  constructor(data: UpdateUserVoiceCommandData) {
    super()
    this.userId = data.userId
    this.voice = data.voice
    this.voiceName = data.voiceName ?? null
  }
}
