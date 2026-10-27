import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { PutAgentRecapResult } from './put-agent-recap.types'

export interface PutAgentRecapRequestData {
  userId: string
  dialogId: string
  recap: string
  source: 'manual' | 'draft'
}

/** `PUT /v1/users/{userId}/dialogs/{dialogId}/recap`: the recap the person wrote in the journal. */
export class PutAgentRecapRequest extends RequestData<PutAgentRecapResult> {
  /** Survives build minification: PutAgentRecapRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'PutAgentRecapRequest'

  public readonly userId: string
  public readonly dialogId: string
  @hasPII(true)
  public readonly recap: string
  public readonly source: 'manual' | 'draft'

  constructor(data: PutAgentRecapRequestData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.recap = data.recap
    this.source = data.source
  }
}
