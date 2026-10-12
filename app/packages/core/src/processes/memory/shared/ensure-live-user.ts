import assertNever from 'assert-never'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'

/**
 * Memory belongs to a live account. A deleted one has had its memory erased at the agent together
 * with everything else, and nothing may be written there again on the strength of a token that has
 * not expired yet. A blocked account keeps reading and forgetting its memory: it is the person's data.
 */
export async function isLiveUser(userId: string): Promise<boolean> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return false
      default:
        return assertNever(found.error)
    }
  }
  return !found.user.isDeleted
}
