import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { inTransaction } from '../../../shared'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  MarkUserEmailConfirmedCommand,
  MarkUserEmailConfirmedCommandErrorCode,
  usersManager,
} from '../../../managers/users-manager'
import { ConfirmUserEmailOperation } from './confirm-user-email.operation'
import { ConfirmUserEmailOperationErrorCode, type ConfirmUserEmailResult } from './confirm-user-email.types'
import { recordAudit } from '../shared/record-audit'

/** Confirming a user's email from the admin panel, with an audit log entry. */
@requestHandler(ConfirmUserEmailOperation)
export class ConfirmUserEmailOperationHandler implements RequestHandler<ConfirmUserEmailOperation, ConfirmUserEmailResult> {
  async handle(operation: ConfirmUserEmailOperation): Promise<ConfirmUserEmailResult> {
    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: ConfirmUserEmailOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.email === null) return { success: false, error: ConfirmUserEmailOperationErrorCode.USER_HAS_NO_EMAIL }

    const failure = await inTransaction(async (): Promise<ConfirmUserEmailOperationErrorCode | null> => {
      const marked = await usersManager.execute(new MarkUserEmailConfirmedCommand({ userId: user.id }))
      if (!marked.success) {
        switch (marked.error) {
          case MarkUserEmailConfirmedCommandErrorCode.USER_NOT_FOUND:
            return ConfirmUserEmailOperationErrorCode.USER_NOT_FOUND
          default:
            assertNever(marked.error)
        }
      }
      await recordAudit({
        adminEmail: operation.adminEmail,
        action: 'USER_EMAIL_CONFIRMED',
        targetUserId: user.id,
        targetEmail: user.email,
      })
      return null
    })
    if (failure) return { success: false, error: failure }
    return { success: true }
  }
}
