import type { UserDTO } from '../../../managers/users-manager'

export enum RegisterOperationErrorCode {
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
  /** A disposable email (mailinator and the like): nobody comes back for a confirmation sent there. */
  DISPOSABLE_EMAIL = 'DISPOSABLE_EMAIL',
}

export type RegisterResult =
  { success: true; user: UserDTO } | { success: false; error: RegisterOperationErrorCode }
