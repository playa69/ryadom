import type { DialogDTO } from '../shared/dialog.dto'

export enum GetDialogOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  /** The dialog does not exist or belongs to someone else, which is the same thing to the client. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type GetDialogResult =
  | { success: true; dialog: DialogDTO }
  | { success: false; error: GetDialogOperationErrorCode }
