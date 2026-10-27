export enum DeleteDialogOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type DeleteDialogResult =
  | { success: true; startedAt: Date }
  | { success: false; error: DeleteDialogOperationErrorCode }
