/**
 * `POST /api/auth/email/link` — gives an anonymous account an address and a password, so that it
 * can also sign in by email on another device.
 *
 * The address is a claim until it is confirmed with the code from the message (the same
 * `POST /api/auth/confirm-email` that follows registration); email sign-in stays closed until then,
 * and the account keeps working as it was. Asking again while the address is unconfirmed replaces
 * it (a typo); a confirmed address is final. 422 when the email does not look like an address or the
 * password length is outside `InputLimit`.
 */

export enum LinkEmailApiErrorCode {
  /** The address belongs to another account, confirmed or not. */
  EMAIL_TAKEN = 'EMAIL_TAKEN',
  /** The account already has a confirmed address. */
  ALREADY_HAS_EMAIL = 'ALREADY_HAS_EMAIL',
  /** A disposable mailbox: there would be nowhere to read the confirmation code. */
  DISPOSABLE_EMAIL = 'DISPOSABLE_EMAIL',
  /** The account is gone. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The account is blocked. */
  USER_INACTIVE = 'USER_INACTIVE',
}

export interface LinkEmailApiRequest {
  email: string
  password: string
}

export interface LinkEmailApiResponse {
  /** The address as the server stored it (trimmed, lower case). */
  email: string
  /** Always true: the address counts only once the code from the message is entered. */
  emailConfirmationRequired: boolean
}
