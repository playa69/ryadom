import { RequestData } from 'mediatr-ts'

import type { ListRecapsResult } from './list-recaps.types'

export interface ListRecapsOperationData {
  userId: string
  limit: number
  before: string | null
}

/** Conversations with a recap, newest first. */
export class ListRecapsOperation extends RequestData<ListRecapsResult> {
  /** Survives minification: ListRecapsOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListRecapsOperation'

  public readonly userId: string
  public readonly limit: number
  public readonly before: string | null

  constructor(data: ListRecapsOperationData) {
    super()
    this.userId = data.userId
    this.limit = data.limit
    this.before = data.before
  }
}
