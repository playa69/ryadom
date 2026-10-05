import type { UserDTO } from '../../shared/user.dto'

export interface ListInactiveAnonymousUsersQueryResult {
  success: true
  /** The longest-idle first. */
  users: UserDTO[]
}
