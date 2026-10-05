import { RequestData } from 'mediatr-ts'
import type { StartAgentDialogResponse } from './start-agent-dialog.types'

export interface StartAgentDialogRequestData {
  userId: string
}

export class StartAgentDialogRequest extends RequestData<StartAgentDialogResponse> {
  /** Survives build minification: StartAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'StartAgentDialogRequest'

  public readonly userId: string

  constructor(data: StartAgentDialogRequestData) {
    super()
    this.userId = data.userId
  }
}
