import type { UserDTO } from '../../shared/user.dto'

export type SearchUsersQueryResult = { success: true; users: UserDTO[]; total: number }
