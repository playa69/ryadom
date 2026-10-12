import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { AgentMemoryFactCategory } from '../../../integrations/agent-api'
import type { MemoryFactSlotsDTO } from '../shared/memory.dto'
import type { CreateMemoryFactResult } from './create-memory-fact.types'

export interface CreateMemoryFactOperationData {
  userId: string
  category: AgentMemoryFactCategory
  /** The person's own words; null for `style` and `person`, whose text the agent builds from the slots. */
  text: string | null
  slots: MemoryFactSlotsDTO | null
}

export class CreateMemoryFactOperation extends RequestData<CreateMemoryFactResult> {
  /** Survives minification: CreateMemoryFactOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateMemoryFactOperation'

  public readonly userId: string
  public readonly category: AgentMemoryFactCategory

  @hasPII(true)
  public readonly text: string | null

  @hasPII(true)
  public readonly slots: MemoryFactSlotsDTO | null

  constructor(data: CreateMemoryFactOperationData) {
    super()
    this.userId = data.userId
    this.category = data.category
    this.text = data.text
    this.slots = data.slots
  }
}
