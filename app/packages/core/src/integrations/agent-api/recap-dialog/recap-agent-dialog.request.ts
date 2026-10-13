import { RequestData } from 'mediatr-ts'
import type { RecapAgentDialogResult } from './recap-agent-dialog.types'

export interface RecapAgentDialogRequestData {
  userId: string
  dialogId: string
}

export class RecapAgentDialogRequest extends RequestData<RecapAgentDialogResult> {
  /** Survives build minification: RecapAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RecapAgentDialogRequest'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: RecapAgentDialogRequestData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
