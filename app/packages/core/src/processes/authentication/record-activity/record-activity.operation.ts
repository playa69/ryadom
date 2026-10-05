import { RequestData } from 'mediatr-ts'
import type { RecordActivityResult } from './record-activity.types'

export interface RecordActivityOperationData {
  userId: string
}

export class RecordActivityOperation extends RequestData<RecordActivityResult> {
  /** Survives minification: RecordActivityOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'RecordActivityOperation'

  public readonly userId: string

  constructor(data: RecordActivityOperationData) {
    super()
    this.userId = data.userId
  }
}
