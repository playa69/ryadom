import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { AgentMemoryFactSlots } from '../shared/agent-memory.types'
import type { UpdateAgentMemoryFactResult } from './update-agent-memory-fact.types'

export interface UpdateAgentMemoryFactRequestData {
  userId: string
  factId: string
  /** The person's correction: personal data. */
  text?: string
  slots?: AgentMemoryFactSlots
  /** `active` accepts a proposed fact ("Remember") or unpins; `pinned` pins. */
  status?: 'active' | 'pinned'
  /** "Right": the fact is confirmed. */
  confirm?: true
}

/** One change to one fact: a correction, accepting, pinning or confirming it. */
export class UpdateAgentMemoryFactRequest extends RequestData<UpdateAgentMemoryFactResult> {
  /** Survives build minification: UpdateAgentMemoryFactRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateAgentMemoryFactRequest'

  public readonly userId: string
  public readonly factId: string

  @hasPII(true)
  public readonly text: string | undefined

  @hasPII(true)
  public readonly slots: AgentMemoryFactSlots | undefined

  public readonly status: 'active' | 'pinned' | undefined
  public readonly confirm: true | undefined

  constructor(data: UpdateAgentMemoryFactRequestData) {
    super()
    this.userId = data.userId
    this.factId = data.factId
    this.text = data.text
    this.slots = data.slots
    this.status = data.status
    this.confirm = data.confirm
  }
}
