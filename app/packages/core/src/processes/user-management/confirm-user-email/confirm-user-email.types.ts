export enum ConfirmUserEmailOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type ConfirmUserEmailResult =
  { success: true } | { success: false; error: ConfirmUserEmailOperationErrorCode }
