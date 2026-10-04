import type { UserDTO } from '../../../managers/users-manager'

export enum LoginOperationErrorCode {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  USER_INACTIVE = 'USER_INACTIVE',
  EMAIL_NOT_CONFIRMED = 'EMAIL_NOT_CONFIRMED',
}

export type LoginResult =
  | { success: true; user: UserDTO }
  | { success: false; error: LoginOperationErrorCode }
