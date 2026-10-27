import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'
import { auditLogManager, RecordAuditLogEntryCommand } from '../../../managers/audit-log-manager'
import { eraseAccount, EraseAccountRefusal } from '../shared/erase-account'
import { PROCESSES_CONFIG } from '../../config'
import { DeleteUserAccountOperation } from './delete-user-account.operation'
import {
  DeleteUserAccountOperationErrorCode,
  type DeleteUserAccountResult,
} from './delete-user-account.types'

/**
 * Deleting an account from the admin panel, for example on a written request from the person. It erases exactly what
 * the person's own request erases (`eraseAccount`, `../shared/erase-account.ts`), in the same order: the agent first,
 * then the account. Only the reason in the archive differs, and an audit entry is written in the same transaction; it
 * keeps the email as it was before anonymization.
 */
@requestHandler(DeleteUserAccountOperation)
export class DeleteUserAccountOperationHandler implements RequestHandler<
  DeleteUserAccountOperation,
  DeleteUserAccountResult
> {
  async handle(operation: DeleteUserAccountOperation): Promise<DeleteUserAccountResult> {
    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: DeleteUserAccountOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: DeleteUserAccountOperationErrorCode.ALREADY_DELETED }

    const refusal = await eraseAccount(user, {
      reason: PROCESSES_CONFIG.DELETION.REASON_ADMIN_REQUEST,
      alsoInTransaction: async () => {
        await auditLogManager.execute(
          new RecordAuditLogEntryCommand({
            entryId: randomUUID(),
            adminEmail: operation.adminEmail,
            action: 'USER_ACCOUNT_DELETED',
            targetUserId: user.id,
            targetEmail: user.email,
            payload: null,
          }),
        )
      },
    })
    if (refusal) {
      switch (refusal) {
        case EraseAccountRefusal.USER_NOT_FOUND:
          return { success: false, error: DeleteUserAccountOperationErrorCode.USER_NOT_FOUND }
        case EraseAccountRefusal.ALREADY_DELETED:
          return { success: false, error: DeleteUserAccountOperationErrorCode.ALREADY_DELETED }
        default:
          assertNever(refusal)
      }
    }
    createLogger('account-deletion').info('Account deleted by admin', { userId: user.id })
    return { success: true }
  }
}
