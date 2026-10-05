import { RequestData } from 'mediatr-ts'
import type { ListAgentDialogsResponse } from './list-agent-dialogs.types'

export interface ListAgentDialogsRequestData {
  userId: string
  limit: number
  /** Cursor from the previous response; null starts from the beginning. */
  before: string | null
}

export class ListAgentDialogsRequest extends RequestData<ListAgentDialogsResponse> {
  /** Survives build minification: ListAgentDialogsRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListAgentDialogsRequest'

  public readonly userId: string
  public readonly limit: number
  public readonly before: string | null

  constructor(data: ListAgentDialogsRequestData) {
    super()
    this.userId = data.userId
    this.limit = data.limit
    this.before = data.before
  }
}
