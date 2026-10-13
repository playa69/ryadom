import { RequestData } from 'mediatr-ts'
import type { ExportMemoryResult } from './export-memory.types'

export interface ExportMemoryOperationData {
  userId: string
}

export class ExportMemoryOperation extends RequestData<ExportMemoryResult> {
  /** Survives minification: ExportMemoryOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ExportMemoryOperation'

  public readonly userId: string

  constructor(data: ExportMemoryOperationData) {
    super()
    this.userId = data.userId
  }
}
