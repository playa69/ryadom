import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'
import { eraseAccount, EraseAccountRefusal } from '../shared/erase-account'
import { PROCESSES_CONFIG } from '../../config'
import { DeleteAccountOperation } from './delete-account.operation'
import { DeleteAccountOperationErrorCode, type DeleteAccountResult } from './delete-account.types'

/**
 * "Erase everything" at the person's request.
 *
 * What is erased, in what order and in which transaction is `eraseAccount` (`../shared/erase-account.ts`), the same for
 * every way an account is deleted. If the agent does not answer, the operation throws `AgentUnavailableError` and the
 * account stays: data cannot be declared erased while the agent still holds it.
 *
 * The deletion is soft: personal data is archived into `users.properties.deletion`, the password and codes are
 * deleted, and the row is anonymized. The email is freed for a new registration.
 */
@requestHandler(DeleteAccountOperation)
export class DeleteAccountOperationHandler implements RequestHandler<
  DeleteAccountOperation,
  DeleteAccountResult
> {
  async handle(operation: DeleteAccountOperation): Promise<DeleteAccountResult> {
    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: DeleteAccountOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: DeleteAccountOperationErrorCode.ALREADY_DELETED }

    const refusal = await eraseAccount(user, { reason: PROCESSES_CONFIG.DELETION.REASON_USER_REQUEST })
    if (refusal) {
      switch (refusal) {
        case EraseAccountRefusal.USER_NOT_FOUND:
          return { success: false, error: DeleteAccountOperationErrorCode.USER_NOT_FOUND }
        case EraseAccountRefusal.ALREADY_DELETED:
          return { success: false, error: DeleteAccountOperationErrorCode.ALREADY_DELETED }
        default:
          assertNever(refusal)
      }
    }
    createLogger('account-deletion').info('Account deleted', { userId: user.id })
    return { success: true }
  }
}
