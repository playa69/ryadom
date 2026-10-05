export enum ResetPasswordOperationErrorCode {
  /** There is no code for this email, or it did not match, was used, or expired. */
  CODE_INVALID = 'CODE_INVALID',
  /** The code did not match for the fifth time in a row. */
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
  USER_INACTIVE = 'USER_INACTIVE',
}

export type ResetPasswordResult =
  { success: true } | { success: false; error: ResetPasswordOperationErrorCode }
