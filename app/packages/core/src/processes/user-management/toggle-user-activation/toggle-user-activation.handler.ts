import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction } from '../../../shared'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  SetUserActiveCommand,
  SetUserActiveCommandErrorCode,
  usersManager,
} from '../../../managers/users-manager'
import {
  RevokeUserRefreshTokensCommand,
  refreshTokensManager,
} from '../../../managers/refresh-tokens-manager'
import { ToggleUserActivationOperation } from './toggle-user-activation.operation'
import {
  ToggleUserActivationOperationErrorCode,
  type ToggleUserActivationResult,
} from './toggle-user-activation.types'
import { recordAudit } from '../shared/record-audit'

/**
 * Blocking and unblocking from the admin panel. A deleted account is left alone. The action is
 * written to the audit log. A blocked user lives on in the application until the access token
 * expires (15 minutes): `/api/auth/refresh` will not extend the session. Their refresh tokens are
 * revoked as well, so unblocking does not bring an old session back: the person signs in again.
 */
@requestHandler(ToggleUserActivationOperation)
export class ToggleUserActivationOperationHandler
  implements RequestHandler<ToggleUserActivationOperation, ToggleUserActivationResult>
{
  async handle(operation: ToggleUserActivationOperation): Promise<ToggleUserActivationResult> {
    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: ToggleUserActivationOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: ToggleUserActivationOperationErrorCode.USER_DELETED }
    const isActive = !user.isActive

    const failure = await inTransaction(async (): Promise<ToggleUserActivationOperationErrorCode | null> => {
      const set = await usersManager.execute(new SetUserActiveCommand({ userId: user.id, isActive }))
      if (!set.success) {
        switch (set.error) {
          case SetUserActiveCommandErrorCode.USER_NOT_FOUND:
            return ToggleUserActivationOperationErrorCode.USER_NOT_FOUND
          case SetUserActiveCommandErrorCode.USER_DELETED:
            return ToggleUserActivationOperationErrorCode.USER_DELETED
          default:
            assertNever(set.error)
        }
      }
      if (!isActive) {
        await refreshTokensManager.execute(
          new RevokeUserRefreshTokensCommand({
            userId: user.id,
            exceptSessionId: null,
            revokedAt: new Date(),
          }),
        )
      }
      await recordAudit({
        adminEmail: operation.adminEmail,
        action: isActive ? 'USER_UNBLOCKED' : 'USER_BLOCKED',
        targetUserId: user.id,
        targetEmail: user.email,
      })
      return null
    })
    if (failure) return { success: false, error: failure }
    createLogger('user-management').info(isActive ? 'User unblocked' : 'User blocked', { userId: user.id })
    return { success: true, isActive }
  }
}
