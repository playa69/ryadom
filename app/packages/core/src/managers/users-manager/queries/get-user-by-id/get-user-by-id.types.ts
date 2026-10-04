import type { UserDTO } from '../../shared/user.dto'

export enum GetUserByIdQueryErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetUserByIdQueryResult =
  { success: true; user: UserDTO } | { success: false; error: GetUserByIdQueryErrorCode }
