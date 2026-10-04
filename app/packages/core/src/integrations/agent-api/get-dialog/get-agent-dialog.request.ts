import { RequestData } from 'mediatr-ts'
import type { GetAgentDialogResult } from './get-agent-dialog.types'

export interface GetAgentDialogRequestData {
  userId: string
  dialogId: string
}

export class GetAgentDialogRequest extends RequestData<GetAgentDialogResult> {
  /** Survives build minification: GetAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetAgentDialogRequest'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: GetAgentDialogRequestData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
