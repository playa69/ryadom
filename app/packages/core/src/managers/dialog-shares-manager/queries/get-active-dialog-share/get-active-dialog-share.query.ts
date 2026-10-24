import { RequestData } from 'mediatr-ts'
import type { GetActiveDialogShareQueryResult } from './get-active-dialog-share.types'

export interface GetActiveDialogShareQueryData {
  userId: string
  dialogId: string
  now: Date
}

export class GetActiveDialogShareQuery extends RequestData<GetActiveDialogShareQueryResult> {
  /** Survives minification: GetActiveDialogShareQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetActiveDialogShareQuery'

  public readonly userId: string
  public readonly dialogId: string
  public readonly now: Date

  constructor(data: GetActiveDialogShareQueryData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.now = data.now
  }
}
