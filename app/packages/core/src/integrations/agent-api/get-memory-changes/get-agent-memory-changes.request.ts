import { RequestData } from 'mediatr-ts'
import type { GetAgentMemoryChangesResult } from './get-agent-memory-changes.types'

export interface GetAgentMemoryChangesRequestData {
  userId: string
  dialogId: string
}

/** The notes one conversation left, for the block "I remembered" in the closing window. */
export class GetAgentMemoryChangesRequest extends RequestData<GetAgentMemoryChangesResult> {
  /** Survives build minification: GetAgentMemoryChangesRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetAgentMemoryChangesRequest'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: GetAgentMemoryChangesRequestData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
