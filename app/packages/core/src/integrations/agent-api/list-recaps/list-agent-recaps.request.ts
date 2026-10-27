import { RequestData } from 'mediatr-ts'
import type { ListAgentRecapsResult } from './list-agent-recaps.types'

export interface ListAgentRecapsRequestData {
  userId: string
  limit: number
  before: string | null
}

/** `GET /v1/users/{userId}/recaps`: conversations with a recap, newest first. */
export class ListAgentRecapsRequest extends RequestData<ListAgentRecapsResult> {
  /** Survives build minification: ListAgentRecapsRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListAgentRecapsRequest'

  public readonly userId: string
  public readonly limit: number
  public readonly before: string | null

  constructor(data: ListAgentRecapsRequestData) {
    super()
    this.userId = data.userId
    this.limit = data.limit
    this.before = data.before
  }
}
