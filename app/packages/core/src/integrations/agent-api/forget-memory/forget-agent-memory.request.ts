import { RequestData } from 'mediatr-ts'
import type { ForgetAgentMemoryResult } from './forget-agent-memory.types'

export interface ForgetAgentMemoryRequestData {
  userId: string
}

/** "Forget everything": every fact and its history. Conversations, the switch and the consent stay. */
export class ForgetAgentMemoryRequest extends RequestData<ForgetAgentMemoryResult> {
  /** Survives build minification: ForgetAgentMemoryRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ForgetAgentMemoryRequest'

  public readonly userId: string

  constructor(data: ForgetAgentMemoryRequestData) {
    super()
    this.userId = data.userId
  }
}
