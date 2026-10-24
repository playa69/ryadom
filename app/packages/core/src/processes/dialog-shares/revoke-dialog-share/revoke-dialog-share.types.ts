export enum RevokeDialogShareOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}

/** Idempotent: with nothing active it is a success too. */
export type RevokeDialogShareResult =
  | { success: true }
  | { success: false; error: RevokeDialogShareOperationErrorCode }
