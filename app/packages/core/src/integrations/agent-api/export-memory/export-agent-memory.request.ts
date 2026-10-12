import { RequestData } from 'mediatr-ts'
import type { ExportAgentMemoryResponse } from './export-agent-memory.types'

export interface ExportAgentMemoryRequestData {
  userId: string
}

/** "Download my memory": the settings, every fact and the history of changes without texts. */
export class ExportAgentMemoryRequest extends RequestData<ExportAgentMemoryResponse> {
  /** Survives build minification: ExportAgentMemoryRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ExportAgentMemoryRequest'

  public readonly userId: string

  constructor(data: ExportAgentMemoryRequestData) {
    super()
    this.userId = data.userId
  }
}
