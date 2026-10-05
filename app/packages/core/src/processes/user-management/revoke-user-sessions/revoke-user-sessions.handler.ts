import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction } from '../../../shared'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'
import {
  RevokeUserRefreshTokensCommand,
  refreshTokensManager,
} from '../../../managers/refresh-tokens-manager'
import { RevokeUserSessionsOperation } from './revoke-user-sessions.operation'
import {
  RevokeUserSessionsOperationErrorCode,
  type RevokeUserSessionsResult,
} from './revoke-user-sessions.types'
import { recordAudit } from '../shared/record-audit'

/**
 * "End all sessions" from the admin panel, for a person whose devices have to be signed out without
 * blocking them (a lost phone, an account somebody else may have signed in to). The account stays
 * active and the person can sign in again at once. Every refresh token is revoked, so each device
 * is out as soon as its access token expires (15 minutes) and a dialog open on it is closed within
 * the gateway's session check. The action is written to the audit log.
 */
@requestHandler(RevokeUserSessionsOperation)
export class RevokeUserSessionsOperationHandler implements RequestHandler<
  RevokeUserSessionsOperation,
  RevokeUserSessionsResult
> {
  async handle(operation: RevokeUserSessionsOperation): Promise<RevokeUserSessionsResult> {
    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: RevokeUserSessionsOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: RevokeUserSessionsOperationErrorCode.USER_DELETED }

    await inTransaction(async () => {
      await refreshTokensManager.execute(
        new RevokeUserRefreshTokensCommand({ userId: user.id, exceptSessionId: null, revokedAt: new Date() }),
      )
      await recordAudit({
        adminEmail: operation.adminEmail,
        action: 'USER_SESSIONS_REVOKED',
        targetUserId: user.id,
        targetEmail: user.email,
      })
    })
    createLogger('user-management').info('Sessions of a user revoked by an admin', { userId: user.id })
    return { success: true }
  }
}
