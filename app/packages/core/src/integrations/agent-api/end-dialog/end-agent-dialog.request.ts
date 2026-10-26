import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { AgentRecapResponse } from '../shared/agent-api.types'
import type { EndAgentDialogResult } from './end-agent-dialog.types'

export interface EndAgentDialogRequestData {
  userId: string
  dialogId: string
  /** The «Что забираешь с собой» note: text written by the person, so personal data. */
  takeaway: string | null
  /** Tension after the conversation, 1-10. */
  tensionAfter: number | null
  /** The recap the person wrote or pre-filled in the end sheet; null: the agent writes it in the background. */
  recap: AgentRecapResponse | null
  recapSource: 'manual' | 'draft'
}

export class EndAgentDialogRequest extends RequestData<EndAgentDialogResult> {
  /** Survives build minification: EndAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'EndAgentDialogRequest'

  public readonly userId: string
  public readonly dialogId: string

  @hasPII(true)
  public readonly takeaway: string | null

  public readonly tensionAfter: number | null

  @hasPII(true)
  public readonly recap: AgentRecapResponse | null

  public readonly recapSource: 'manual' | 'draft'

  constructor(data: EndAgentDialogRequestData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.takeaway = data.takeaway
    this.tensionAfter = data.tensionAfter
    this.recap = data.recap
    this.recapSource = data.recapSource
  }
}
