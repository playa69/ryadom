export enum ConfirmUserEmailOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** An anonymous account: there is no address to confirm. */
  USER_HAS_NO_EMAIL = 'USER_HAS_NO_EMAIL',
}

export type ConfirmUserEmailResult =
  { success: true } | { success: false; error: ConfirmUserEmailOperationErrorCode }
