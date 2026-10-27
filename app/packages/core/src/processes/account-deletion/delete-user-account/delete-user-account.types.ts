export enum DeleteUserAccountOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  ALREADY_DELETED = 'ALREADY_DELETED',
}

export type DeleteUserAccountResult =
  | { success: true }
  | { success: false; error: DeleteUserAccountOperationErrorCode }
