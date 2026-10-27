import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { UpdateAgentMemoryFactResult } from './update-agent-memory-fact.types'

export interface UpdateAgentMemoryFactRequestData {
  userId: string
  /** The id of a note; the clients that predate notes call it a fact. */
  factId: string
  /** The person's correction: personal data. */
  text: string
}

/** The person corrects the text of one note. */
export class UpdateAgentMemoryFactRequest extends RequestData<UpdateAgentMemoryFactResult> {
  /** Survives build minification: UpdateAgentMemoryFactRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateAgentMemoryFactRequest'

  public readonly userId: string
  public readonly factId: string

  @hasPII(true)
  public readonly text: string

  constructor(data: UpdateAgentMemoryFactRequestData) {
    super()
    this.userId = data.userId
    this.factId = data.factId
    this.text = data.text
  }
}
