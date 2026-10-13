import { RequestData } from 'mediatr-ts'
import type { RecapDialogResult } from './recap-dialog.types'

export interface RecapDialogOperationData {
  userId: string
  dialogId: string
}

export class RecapDialogOperation extends RequestData<RecapDialogResult> {
  /** Survives minification: RecapDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'RecapDialogOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: RecapDialogOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
