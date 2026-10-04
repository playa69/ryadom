/**
 * `POST /api/auth/reset-password` — a new password with the code from the email: the
 * code and the password in one form. A success answers `null`, after which the app signs in with the
 * new password by itself.
 */

export enum ResetPasswordApiErrorCode {
  /** There is no code, or it did not match, was already used or expired. */
  CODE_INVALID = 'CODE_INVALID',
  /** The fifth wrong attempt in a row: the code is burned. */
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
  /** The account is blocked, so changing the password is pointless. */
  USER_INACTIVE = 'USER_INACTIVE',
}

export interface ResetPasswordApiRequest {
  email: string
  code: string
  newPassword: string
}
