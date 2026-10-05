export enum VerifyEmailCodeCommandErrorCode {
  /** No code for this email and purpose, or it is burned (used or out of attempts) or expired. */
  CODE_NOT_FOUND = 'CODE_NOT_FOUND',
  /** The code did not match; the attempt was counted. */
  CODE_MISMATCH = 'CODE_MISMATCH',
  /** Fifth consecutive mismatch: the code is burned and a new one is needed. */
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
}

export type VerifyEmailCodeCommandResult =
  | { success: true }
  | { success: false; error: VerifyEmailCodeCommandErrorCode }
