export enum ConfirmEmailOperationErrorCode {
  /** There is no code for this email, or it did not match, was used, or expired; request a new one. */
  CODE_INVALID = 'CODE_INVALID',
  /** The code did not match for the fifth time in a row. */
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
  EMAIL_ALREADY_CONFIRMED = 'EMAIL_ALREADY_CONFIRMED',
}

export type ConfirmEmailResult =
  | { success: true; userId: string }
  | { success: false; error: ConfirmEmailOperationErrorCode }
