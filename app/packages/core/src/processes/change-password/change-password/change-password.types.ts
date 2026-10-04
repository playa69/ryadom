export enum ChangePasswordOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_CURRENT_PASSWORD = 'INVALID_CURRENT_PASSWORD',
}

export type ChangePasswordResult =
  { success: true } | { success: false; error: ChangePasswordOperationErrorCode }
