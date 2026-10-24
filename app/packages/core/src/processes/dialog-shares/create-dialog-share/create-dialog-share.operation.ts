import { RequestData } from 'mediatr-ts'
import type { CreateDialogShareResult } from './create-dialog-share.types'

export interface CreateDialogShareOperationData {
  userId: string
  dialogId: string
  ttlHours?: number
}

export class CreateDialogShareOperation extends RequestData<CreateDialogShareResult> {
  /** Survives minification: CreateDialogShareOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateDialogShareOperation'

  public readonly userId: string
  public readonly dialogId: string
  public readonly ttlHours?: number

  constructor(data: CreateDialogShareOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.ttlHours = data.ttlHours
  }
}
