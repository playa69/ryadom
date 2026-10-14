import type { UserDTO } from '../../shared/user.dto'

export enum GetUserByTelegramIdQueryErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetUserByTelegramIdQueryResult =
  { success: true; user: UserDTO } | { success: false; error: GetUserByTelegramIdQueryErrorCode }
