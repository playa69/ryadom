import { RequestData } from 'mediatr-ts'

import type { DeleteDialogResult } from './delete-dialog.types'

export interface DeleteDialogOperationData {
  userId: string
  dialogId: string
}

/**
 * «Delete the conversation» in the journal: the agent deletes it with its recap, the share link goes out; the notes of memory stay.
 * A job that resets the week text is queued before the agent is asked (`openspec/changes/archive/2026-10-27-add-job-queue`).
 */
export class DeleteDialogOperation extends RequestData<DeleteDialogResult> {
  /** Survives minification: DeleteDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteDialogOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: DeleteDialogOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
