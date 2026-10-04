export enum DeleteAccountOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  ALREADY_DELETED = 'ALREADY_DELETED',
}

export type DeleteAccountResult =
  | { success: true }
  | { success: false; error: DeleteAccountOperationErrorCode }
