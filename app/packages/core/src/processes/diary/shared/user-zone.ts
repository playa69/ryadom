import assertNever from 'assert-never'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'

/** The IANA zone of an existing person; null when there is no such account (or it was deleted). */
export async function userZone(userId: string): Promise<string | null> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return null
      default:
        return assertNever(found.error)
    }
  }
  return found.user.isDeleted ? null : found.user.timezone
}
