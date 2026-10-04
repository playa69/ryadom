import { RequestData } from 'mediatr-ts'
import type { ListDialogsResult } from './list-dialogs.types'

export interface ListDialogsOperationData {
  userId: string
  limit: number
  before: string | null
}

export class ListDialogsOperation extends RequestData<ListDialogsResult> {
  /** Survives minification: ListDialogsOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListDialogsOperation'

  public readonly userId: string
  public readonly limit: number
  public readonly before: string | null

  constructor(data: ListDialogsOperationData) {
    super()
    this.userId = data.userId
    this.limit = data.limit
    this.before = data.before
  }
}
