import { RequestData } from 'mediatr-ts'
import type { GetAgentMemoryResponse } from './get-agent-memory.types'

export interface GetAgentMemoryRequestData {
  userId: string
}

/** Everything the agent remembers about the person, with their switch and the state of the feature. */
export class GetAgentMemoryRequest extends RequestData<GetAgentMemoryResponse> {
  /** Survives build minification: GetAgentMemoryRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetAgentMemoryRequest'

  public readonly userId: string

  constructor(data: GetAgentMemoryRequestData) {
    super()
    this.userId = data.userId
  }
}
