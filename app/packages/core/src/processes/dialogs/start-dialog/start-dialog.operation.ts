import { RequestData } from 'mediatr-ts'
import type { StartDialogResult } from './start-dialog.types'

export interface StartDialogOperationData {
  userId: string
}

export class StartDialogOperation extends RequestData<StartDialogResult> {
  /** Survives minification: StartDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'StartDialogOperation'

  public readonly userId: string

  constructor(data: StartDialogOperationData) {
    super()
    this.userId = data.userId
  }
}
