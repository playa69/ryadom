import { RequestData } from 'mediatr-ts'
import type { StartDialogResult } from './start-dialog.types'

export interface StartDialogOperationData {
  userId: string
  /**
   * The person chose to end the open dialog and begin a new one. Without it a start only returns the
   * open dialog (if there is one) and changes nothing.
   */
  startNew?: boolean
}

export class StartDialogOperation extends RequestData<StartDialogResult> {
  /** Survives minification: StartDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'StartDialogOperation'

  public readonly userId: string
  public readonly startNew: boolean

  constructor(data: StartDialogOperationData) {
    super()
    this.userId = data.userId
    this.startNew = data.startNew === true
  }
}
