import { RequestData } from 'mediatr-ts'
import type { GetMemoryChangesResult } from './get-memory-changes.types'

export interface GetMemoryChangesOperationData {
  userId: string
  dialogId: string
}

export class GetMemoryChangesOperation extends RequestData<GetMemoryChangesResult> {
  /** Survives minification: GetMemoryChangesOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetMemoryChangesOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: GetMemoryChangesOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
