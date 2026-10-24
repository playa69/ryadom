import { RequestData } from 'mediatr-ts'
import type { DeleteUserDialogSharesCommandResult } from './delete-user-dialog-shares.types'

export interface DeleteUserDialogSharesCommandData {
  userId: string
}

export class DeleteUserDialogSharesCommand extends RequestData<DeleteUserDialogSharesCommandResult> {
  /** Survives minification: DeleteUserDialogSharesCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteUserDialogSharesCommand'

  public readonly userId: string

  constructor(data: DeleteUserDialogSharesCommandData) {
    super()
    this.userId = data.userId
  }
}
