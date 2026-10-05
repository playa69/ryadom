import assertNever from 'assert-never'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'

/** Why the user is not allowed to hold a dialog. */
export enum DialogAccessRefusal {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}

/**
 * A conversation is only available to a live, active account. The check is shared by all
 * dialog operations, so it lives in this process's `shared/` instead of being repeated in
 * every handler.
 */
export async function ensureActiveUser(userId: string): Promise<DialogAccessRefusal | null> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return DialogAccessRefusal.USER_NOT_FOUND
      default:
        return assertNever(found.error)
    }
  }
  if (found.user.isDeleted) return DialogAccessRefusal.USER_NOT_FOUND
  if (!found.user.isActive) return DialogAccessRefusal.USER_INACTIVE
  return null
}
