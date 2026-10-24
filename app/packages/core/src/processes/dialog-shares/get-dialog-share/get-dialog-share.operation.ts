import { RequestData } from 'mediatr-ts'
import type { GetDialogShareResult } from './get-dialog-share.types'

export interface GetDialogShareOperationData {
  userId: string
  dialogId: string
}

export class GetDialogShareOperation extends RequestData<GetDialogShareResult> {
  /** Survives minification: GetDialogShareOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetDialogShareOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: GetDialogShareOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
