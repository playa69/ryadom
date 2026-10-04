import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction } from '../../../shared'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  GetUserDeletionArchiveQuery,
  GetUserDeletionArchiveQueryErrorCode,
  SetUserDeletionArchiveCommand,
  SetUserDeletionArchiveCommandErrorCode,
  SoftDeleteUserCommand,
  SoftDeleteUserCommandErrorCode,
  usersManager,
} from '../../../managers/users-manager'
import {
  DeleteUserCredentialsCommand,
  GetUserCredentialsQuery,
  GetUserCredentialsQueryErrorCode,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import { DeleteEmailCodesCommand, emailCodesManager } from '../../../managers/email-codes-manager'
import { agentApiIntegration, EraseAgentUserRequest } from '../../../integrations/agent-api'
import { PROCESSES_CONFIG } from '../../config'
import { DeleteUserAccountOperation } from './delete-user-account.operation'
import { DeleteUserAccountOperationErrorCode, type DeleteUserAccountResult } from './delete-user-account.types'
import { recordAudit } from '../shared/record-audit'
import type { UserDTO } from '../../../managers/users-manager'

/**
 * Snapshot of personal data before the cleanup. The steps repeat `account-deletion` because
 * processes do not call each other (core rules), so the archive is built here again, with a
 * different reason.
 */
async function buildArchive(user: UserDTO): Promise<Record<string, unknown>> {
  const credentials = await userCredentialsManager.execute(new GetUserCredentialsQuery({ userId: user.id }))
  if (!credentials.success) {
    switch (credentials.error) {
      case GetUserCredentialsQueryErrorCode.CREDENTIALS_NOT_FOUND:
        break
      default:
        assertNever(credentials.error)
    }
  }
  return {
    anonymized_at: new Date().toISOString(),
    reason: PROCESSES_CONFIG.DELETION.REASON_ADMIN_REQUEST,
    profile: {
      email: user.email,
      name: user.name,
      is_active: user.isActive,
      is_email_confirmed: user.isEmailConfirmed,
      created_at: user.createdAt.toISOString(),
    },
    user_credentials: credentials.success
      ? [
          {
            user_id: credentials.credentials.userId,
            password_hash: credentials.credentials.passwordHash,
            created_at: credentials.credentials.createdAt.toISOString(),
          },
        ]
      : [],
    agent_data_erased: true,
  }
}

/**
 * Deleting an account from the admin panel, for example on a written request from the person.
 * The order is the same as for self-deletion: erase on the agent side first, then anonymize;
 * plus an audit entry that keeps the email as it was before anonymization.
 */
@requestHandler(DeleteUserAccountOperation)
export class DeleteUserAccountOperationHandler
  implements RequestHandler<DeleteUserAccountOperation, DeleteUserAccountResult>
{
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
    const userId = user.id

    await agentApiIntegration.execute(new EraseAgentUserRequest({ userId }))

    const failure = await inTransaction(async (): Promise<DeleteUserAccountOperationErrorCode | null> => {
      const existing = await usersManager.execute(new GetUserDeletionArchiveQuery({ userId }))
      if (!existing.success) {
        switch (existing.error) {
          case GetUserDeletionArchiveQueryErrorCode.USER_NOT_FOUND:
            return DeleteUserAccountOperationErrorCode.USER_NOT_FOUND
          default:
            assertNever(existing.error)
        }
      }
      if (!existing.archive) {
        const archive = await buildArchive(user)
        const persisted = await usersManager.execute(new SetUserDeletionArchiveCommand({ userId, archive }))
        if (!persisted.success) {
          switch (persisted.error) {
            case SetUserDeletionArchiveCommandErrorCode.USER_NOT_FOUND:
              return DeleteUserAccountOperationErrorCode.USER_NOT_FOUND
            default:
              assertNever(persisted.error)
          }
        }
      }

      await userCredentialsManager.execute(new DeleteUserCredentialsCommand({ userId }))
      await emailCodesManager.execute(new DeleteEmailCodesCommand({ email: user.email }))

      const deleted = await usersManager.execute(new SoftDeleteUserCommand({ userId }))
      if (!deleted.success) {
        switch (deleted.error) {
          case SoftDeleteUserCommandErrorCode.USER_NOT_FOUND:
            return DeleteUserAccountOperationErrorCode.USER_NOT_FOUND
          case SoftDeleteUserCommandErrorCode.ALREADY_DELETED:
            return DeleteUserAccountOperationErrorCode.ALREADY_DELETED
          default:
            assertNever(deleted.error)
        }
      }
      await recordAudit({
        adminEmail: operation.adminEmail,
        action: 'USER_ACCOUNT_DELETED',
        targetUserId: userId,
        targetEmail: user.email,
      })
      return null
    })
    if (failure) return { success: false, error: failure }
    createLogger('user-management').info('Account deleted by admin', { userId })
    return { success: true }
  }
}
