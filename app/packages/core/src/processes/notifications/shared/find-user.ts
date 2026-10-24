import assertNever from 'assert-never'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager, type UserDTO } from '../../../managers/users-manager'

/** The person's account; null when there is none or it was deleted. */
export async function findUser(userId: string): Promise<UserDTO | null> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return null
      default:
        return assertNever(found.error)
    }
  }
  return found.user.isDeleted ? null : found.user
}
