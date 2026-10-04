/**
 * `POST /api/auth/confirm-email` — confirms the email with the code from the message.
 * A success answers `null`, after which the app signs in with the password by itself.
 */

export enum ConfirmEmailApiErrorCode {
  /** There is no code, or it did not match, was already used or expired: request a new one. */
  CODE_INVALID = 'CODE_INVALID',
  /** The fifth wrong attempt in a row: the code is burned. */
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
  /** The email is already confirmed, so signing in is possible. */
  EMAIL_ALREADY_CONFIRMED = 'EMAIL_ALREADY_CONFIRMED',
}

export interface ConfirmEmailApiRequest {
  email: string
  code: string
}
