import { RequestData } from 'mediatr-ts'
import type { DeleteAgentMemoryFactResult } from './delete-agent-memory-fact.types'

export interface DeleteAgentMemoryFactRequestData {
  userId: string
  factId: string
}

/** "Forget" one note. A repeat is a success. */
export class DeleteAgentMemoryFactRequest extends RequestData<DeleteAgentMemoryFactResult> {
  /** Survives build minification: DeleteAgentMemoryFactRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteAgentMemoryFactRequest'

  public readonly userId: string
  public readonly factId: string

  constructor(data: DeleteAgentMemoryFactRequestData) {
    super()
    this.userId = data.userId
    this.factId = data.factId
  }
}
