import { RequestData } from 'mediatr-ts'
import type { ForgetMemoryFactResult } from './forget-memory-fact.types'

export interface ForgetMemoryFactOperationData {
  userId: string
  factId: string
}

export class ForgetMemoryFactOperation extends RequestData<ForgetMemoryFactResult> {
  /** Survives minification: ForgetMemoryFactOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ForgetMemoryFactOperation'

  public readonly userId: string
  public readonly factId: string

  constructor(data: ForgetMemoryFactOperationData) {
    super()
    this.userId = data.userId
    this.factId = data.factId
  }
}
