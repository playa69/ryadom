import { RequestData } from 'mediatr-ts'
import type { GetDialogResult } from './get-dialog.types'

export interface GetDialogOperationData {
  userId: string
  dialogId: string
}

export class GetDialogOperation extends RequestData<GetDialogResult> {
  /** Survives minification: GetDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetDialogOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: GetDialogOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
