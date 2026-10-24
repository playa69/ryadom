import { RequestData } from 'mediatr-ts'
import type { RevokeDialogShareCommandResult } from './revoke-dialog-share.types'

export interface RevokeDialogShareCommandData {
  userId: string
  dialogId: string
  now: Date
}

export class RevokeDialogShareCommand extends RequestData<RevokeDialogShareCommandResult> {
  /** Survives minification: RevokeDialogShareCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeDialogShareCommand'

  public readonly userId: string
  public readonly dialogId: string
  public readonly now: Date

  constructor(data: RevokeDialogShareCommandData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.now = data.now
  }
}
