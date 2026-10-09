import { RequestData } from 'mediatr-ts'
import type { AgentVoice } from '@ryadom/db/schema'
import type { UpdateUserVoiceCommandResult } from './update-user-voice.types'

export interface UpdateUserVoiceCommandData {
  userId: string
  voice: AgentVoice
}

/** Sets the voice the agent speaks with. It reaches the agent when the next conversation starts. */
export class UpdateUserVoiceCommand extends RequestData<UpdateUserVoiceCommandResult> {
  static readonly requestName = 'UpdateUserVoiceCommand'

  public readonly userId: string
  public readonly voice: AgentVoice

  constructor(data: UpdateUserVoiceCommandData) {
    super()
    this.userId = data.userId
    this.voice = data.voice
  }
}
