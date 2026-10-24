import { RequestData } from 'mediatr-ts'
import type { RevokeDialogShareResult } from './revoke-dialog-share.types'

export interface RevokeDialogShareOperationData {
  userId: string
  dialogId: string
}

export class RevokeDialogShareOperation extends RequestData<RevokeDialogShareResult> {
  /** Survives minification: RevokeDialogShareOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeDialogShareOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: RevokeDialogShareOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
