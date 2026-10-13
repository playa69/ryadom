import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { AgentMemoryFactCategory, AgentMemoryFactSlots } from '../shared/agent-memory.types'
import type { CreateAgentMemoryFactResult } from './create-agent-memory-fact.types'

export interface CreateAgentMemoryFactRequestData {
  userId: string
  category: AgentMemoryFactCategory
  /** Written by the person about themselves: personal data. Null for `style` and `person`, built from the slots. */
  text: string | null
  slots: AgentMemoryFactSlots | null
}

/** The person writes a fact themselves: it becomes theirs and pinned. */
export class CreateAgentMemoryFactRequest extends RequestData<CreateAgentMemoryFactResult> {
  /** Survives build minification: CreateAgentMemoryFactRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateAgentMemoryFactRequest'

  public readonly userId: string
  public readonly category: AgentMemoryFactCategory

  @hasPII(true)
  public readonly text: string | null

  @hasPII(true)
  public readonly slots: AgentMemoryFactSlots | null

  constructor(data: CreateAgentMemoryFactRequestData) {
    super()
    this.userId = data.userId
    this.category = data.category
    this.text = data.text
    this.slots = data.slots
  }
}
