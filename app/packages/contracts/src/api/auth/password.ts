/**
 * `POST /api/auth/password` — change the password using the current one. 400 when
 * required fields are missing; 422 when the new password length is outside `InputLimit`. A success
 * answers `null`.
 */

export enum ChangePasswordApiErrorCode {
  /** The account is gone. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The current password did not match, which is human input, not an expired session. */
  INVALID_CURRENT_PASSWORD = 'INVALID_CURRENT_PASSWORD',
}

export interface ChangePasswordApiRequest {
  currentPassword: string
  newPassword: string
}
