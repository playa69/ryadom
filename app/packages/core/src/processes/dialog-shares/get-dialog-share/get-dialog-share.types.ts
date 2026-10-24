import type { OwnedDialogShareDTO } from '../shared/dialog-share.dto'

export enum GetDialogShareOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  /** No active link on this dialog (also: not the person's dialog, or links are off). */
  SHARE_NOT_FOUND = 'SHARE_NOT_FOUND',
}

export type GetDialogShareResult =
  | { success: true; share: OwnedDialogShareDTO }
  | { success: false; error: GetDialogShareOperationErrorCode }
