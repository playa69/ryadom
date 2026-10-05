import type { UserDTO } from '../../shared/user.dto'

export enum GetUserByEmailQueryErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetUserByEmailQueryResult =
  { success: true; user: UserDTO } | { success: false; error: GetUserByEmailQueryErrorCode }
