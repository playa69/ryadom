import { RequestData } from 'mediatr-ts'
import type { EraseAgentUserResponse } from './erase-agent-user.types'

export interface EraseAgentUserRequestData {
  userId: string
}

/**
 * Erases everything the agent remembers about the person: transcripts, memory, profile.
 * Called on account deletion, before we declare the data deleted.
 */
export class EraseAgentUserRequest extends RequestData<EraseAgentUserResponse> {
  /** Survives build minification: EraseAgentUserRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'EraseAgentUserRequest'

  public readonly userId: string

  constructor(data: EraseAgentUserRequestData) {
    super()
    this.userId = data.userId
  }
}
