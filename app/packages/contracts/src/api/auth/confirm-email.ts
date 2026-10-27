/**
 * `POST /api/auth/confirm-email` — confirms the email with the code from the message.
 * A success answers `null`, after which the app signs in with the password by itself.
 *
 * Send the `Authorization` token when the client has a session. A registration is confirmed without
 * one; an address linked by a guest or Telegram account is confirmed only from that account's session,
 * and from anywhere else the answer is `CODE_INVALID` with the code left intact.
 */

export enum ConfirmEmailApiErrorCode {
  /** There is no code, or it did not match, was already used or expired, or the address is a guest account's and the request is not from it. */
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
