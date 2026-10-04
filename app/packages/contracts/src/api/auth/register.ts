/**
 * `POST /api/auth/register` — registration with email and password.
 *
 * It issues no session: sign-in opens only after the email is confirmed with the code from the
 * message. 400 when the email, password or name is missing; 422 when the email does not look like an
 * address or the password or name length is outside `InputLimit`.
 */

export enum RegisterApiErrorCode {
  /** The address is already taken by another account. */
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
  /** A disposable mailbox: there would be nowhere to read the confirmation code. */
  DISPOSABLE_EMAIL = 'DISPOSABLE_EMAIL',
}

export interface RegisterApiRequest {
  email: string
  password: string
  /** How to address the person. */
  name: string
}

export interface RegisterApiResponse {
  email: string
  /** Always true: signing in is possible only after the email is confirmed. */
  emailConfirmationRequired: boolean
}
