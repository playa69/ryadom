export enum DeleteDialogOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type DeleteDialogResult =
  /**
   * `afterDeleteJobId`: the job `dialogs.after-delete` queued before the agent was asked (null when one for this
   * conversation was already waiting). The caller cancels it once it has reset the week itself.
   */
  | { success: true; startedAt: Date; afterDeleteJobId: string | null }
  | { success: false; error: DeleteDialogOperationErrorCode }
