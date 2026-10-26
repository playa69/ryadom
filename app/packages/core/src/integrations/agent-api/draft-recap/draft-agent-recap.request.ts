import { RequestData } from 'mediatr-ts'
import type { DraftAgentRecapResult } from './draft-agent-recap.types'

export interface DraftAgentRecapRequestData {
  userId: string
  dialogId: string
}

/** `POST /v1/users/{userId}/dialogs/{dialogId}/recap/draft`: a draft recap for «Предзаполнить»; the agent stores nothing. */
export class DraftAgentRecapRequest extends RequestData<DraftAgentRecapResult> {
  /** Survives build minification: DraftAgentRecapRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DraftAgentRecapRequest'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: DraftAgentRecapRequestData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
