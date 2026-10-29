import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { MemoryInstructionResult } from './memory-instruction.types'

export interface MemoryInstructionOperationData {
  userId: string
  /** The person's own words; never logged. */
  text: string
}

/** "Tell Ryadom what to correct or remove": the person asks in words, the agent carries it out on their notes. */
export class MemoryInstructionOperation extends RequestData<MemoryInstructionResult> {
  /** Survives minification: MemoryInstructionOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'MemoryInstructionOperation'

  public readonly userId: string
  @hasPII(true)
  public readonly text: string

  constructor(data: MemoryInstructionOperationData) {
    super()
    this.userId = data.userId
    this.text = data.text
  }
}
