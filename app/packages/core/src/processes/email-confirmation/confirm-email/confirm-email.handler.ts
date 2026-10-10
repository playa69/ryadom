import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction, validateInput } from '../../../shared'
import {
  emailCodesManager,
  VerifyEmailCodeCommand,
  VerifyEmailCodeCommandErrorCode,
} from '../../../managers/email-codes-manager'
import {
  GetUserByEmailQuery,
  GetUserByEmailQueryErrorCode,
  MarkUserEmailConfirmedCommand,
  MarkUserEmailConfirmedCommandErrorCode,
  usersManager,
} from '../../../managers/users-manager'
import { DeleteUserDevicesCommand, userDevicesManager } from '../../../managers/user-devices-manager'
import { HashTokenRequest, tokenService } from '../../../services/token-service'
import { ConfirmEmailOperation } from './confirm-email.operation'
import { ConfirmEmailOperationErrorCode, type ConfirmEmailResult } from './confirm-email.types'
import { confirmEmailSchema } from './confirm-email.validator'

/**
 * The code from the email: the code is burned and the account's email is marked
 * as confirmed. If there is no account with this email (the person managed to delete
 * themselves) or the email is already confirmed, the code is burned anyway; both cases look
 * the same to whoever entered it (EMAIL_ALREADY_CONFIRMED).
 */
@requestHandler(ConfirmEmailOperation)
export class ConfirmEmailOperationHandler implements RequestHandler<ConfirmEmailOperation, ConfirmEmailResult> {
  async handle(operation: ConfirmEmailOperation): Promise<ConfirmEmailResult> {
    const logger = createLogger('email-confirmation')
    const input = validateInput(confirmEmailSchema, { email: operation.email, code: operation.code })
    const { tokenHash: codeHash } = await tokenService.execute(new HashTokenRequest({ token: input.code }))

    const verified = await emailCodesManager.execute(
      new VerifyEmailCodeCommand({ email: input.email, purpose: 'confirm_email', codeHash }),
    )
    if (!verified.success) {
      switch (verified.error) {
        case VerifyEmailCodeCommandErrorCode.CODE_NOT_FOUND:
        case VerifyEmailCodeCommandErrorCode.CODE_MISMATCH:
          return { success: false, error: ConfirmEmailOperationErrorCode.CODE_INVALID }
        case VerifyEmailCodeCommandErrorCode.TOO_MANY_ATTEMPTS:
          return { success: false, error: ConfirmEmailOperationErrorCode.TOO_MANY_ATTEMPTS }
        default:
          return assertNever(verified.error)
      }
    }

    const userResult = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
          logger.info('Confirm email: user disappeared after a valid code')
          return { success: false, error: ConfirmEmailOperationErrorCode.EMAIL_ALREADY_CONFIRMED }
        default:
          return assertNever(userResult.error)
      }
    }
    if (userResult.user.isEmailConfirmed) {
      return { success: false, error: ConfirmEmailOperationErrorCode.EMAIL_ALREADY_CONFIRMED }
    }

    // With a confirmed address the account has a way in that needs no device: its password. The
    // device keys are forgotten with it, otherwise signing out of a shared phone would not sign
    // anyone out, since the key left on it would open the account again.
    const userId = userResult.user.id
    await inTransaction(async () => {
      const marked = await usersManager.execute(new MarkUserEmailConfirmedCommand({ userId }))
      if (!marked.success) {
        switch (marked.error) {
          case MarkUserEmailConfirmedCommandErrorCode.USER_NOT_FOUND:
            throw new Error('User disappeared between lookup and email confirmation')
          default:
            return assertNever(marked.error)
        }
      }
      await userDevicesManager.execute(new DeleteUserDevicesCommand({ userId }))
    })
    logger.info('Email confirmed', { userId })
    return { success: true, userId }
  }
}
