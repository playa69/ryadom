import { RequestData } from 'mediatr-ts'
import type { GetMemoryResult } from './get-memory.types'

export interface GetMemoryOperationData {
  userId: string
}

export class GetMemoryOperation extends RequestData<GetMemoryResult> {
  /** Survives minification: GetMemoryOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetMemoryOperation'

  public readonly userId: string

  constructor(data: GetMemoryOperationData) {
    super()
    this.userId = data.userId
  }
}
