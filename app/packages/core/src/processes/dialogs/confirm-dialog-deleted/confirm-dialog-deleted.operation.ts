import { RequestData } from 'mediatr-ts'
import type { ConfirmDialogDeletedResult } from './confirm-dialog-deleted.types'

export interface ConfirmDialogDeletedOperationData {
  userId: string
  dialogId: string
}

/**
 * The follow-up of «Delete the conversation» (the job `dialogs.after-delete`, queued before the agent was asked): looks at
 * the agent, and when the conversation is gone makes sure the share link is gone too. Idempotent.
 */
export class ConfirmDialogDeletedOperation extends RequestData<ConfirmDialogDeletedResult> {
  /** Survives minification: ConfirmDialogDeletedOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ConfirmDialogDeletedOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: ConfirmDialogDeletedOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
