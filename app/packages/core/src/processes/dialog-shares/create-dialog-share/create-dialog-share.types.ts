import type { OwnedDialogShareDTO } from '../shared/dialog-share.dto'

export enum CreateDialogShareOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
  /** The dialog already has an active link. */
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  LIMIT_REACHED = 'LIMIT_REACHED',
  /** `ttlHours` is not one of the allowed values. */
  INVALID_TTL = 'INVALID_TTL',
  DISABLED = 'DISABLED',
}

export type CreateDialogShareResult =
  | { success: true; share: OwnedDialogShareDTO }
  | { success: false; error: CreateDialogShareOperationErrorCode }
