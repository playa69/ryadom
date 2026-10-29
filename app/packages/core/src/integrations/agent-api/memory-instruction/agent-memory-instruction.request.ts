import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { AgentMemoryInstructionResult } from './agent-memory-instruction.types'

export interface AgentMemoryInstructionRequestData {
  userId: string
  /** The person's own words: "forget about my dog", "I moved to Kazan". Never logged. */
  text: string
}

/** The field "Tell Ryadom what to correct or remove". */
export class AgentMemoryInstructionRequest extends RequestData<AgentMemoryInstructionResult> {
  /** Survives build minification: AgentMemoryInstructionRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'AgentMemoryInstructionRequest'

  public readonly userId: string
  @hasPII(true)
  public readonly text: string

  constructor(data: AgentMemoryInstructionRequestData) {
    super()
    this.userId = data.userId
    this.text = data.text
  }
}
