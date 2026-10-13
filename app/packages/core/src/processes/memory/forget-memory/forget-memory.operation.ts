import { RequestData } from 'mediatr-ts'
import type { ForgetMemoryResult } from './forget-memory.types'

export interface ForgetMemoryOperationData {
  userId: string
}

export class ForgetMemoryOperation extends RequestData<ForgetMemoryResult> {
  /** Survives minification: ForgetMemoryOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ForgetMemoryOperation'

  public readonly userId: string

  constructor(data: ForgetMemoryOperationData) {
    super()
    this.userId = data.userId
  }
}
