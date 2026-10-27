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
  type UserDTO,
} from '../../../managers/users-manager'
import {
  DeleteUserDevicesCommand,
  HasUserDevicesQuery,
  userDevicesManager,
} from '../../../managers/user-devices-manager'
import { HashTokenRequest, tokenService } from '../../../services/token-service'
import { ConfirmEmailOperation } from './confirm-email.operation'
import { ConfirmEmailOperationErrorCode, type ConfirmEmailResult } from './confirm-email.types'
import { confirmEmailSchema } from './confirm-email.validator'

/**
 * The code from the email: the code is burned and the account's email is marked
 * as confirmed. If there is no account with this email (the person managed to delete
 * themselves) or the email is already confirmed, the code is burned anyway; both cases look
 * the same to whoever entered it (EMAIL_ALREADY_CONFIRMED).
 *
 * The code proves who owns the mailbox, not whose account the address is on. A registration that
 * nobody has signed in with is confirmed by whoever holds the code: it is the person who registered
 * it. A guest or Telegram account that typed the address is somebody's account with their data, and
 * the mailbox may well be a stranger's (a typo): once its address is confirmed, "I forgot my
 * password" on that address would hand the whole account to the mailbox owner. So such an address is
 * confirmed only from that account's own session (`callerUserId`); from anywhere else the answer is
 * CODE_INVALID and the code is left untouched, for the account's own person to use.
 */
@requestHandler(ConfirmEmailOperation)
export class ConfirmEmailOperationHandler implements RequestHandler<ConfirmEmailOperation, ConfirmEmailResult> {
  async handle(operation: ConfirmEmailOperation): Promise<ConfirmEmailResult> {
    const logger = createLogger('email-confirmation')
    const input = validateInput(confirmEmailSchema, { email: operation.email, code: operation.code })
    const { tokenHash: codeHash } = await tokenService.execute(new HashTokenRequest({ token: input.code }))

    const found = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
    let holder: UserDTO | null = null
    if (found.success) {
      holder = found.user
    } else {
      switch (found.error) {
        case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
          break
        default:
          return assertNever(found.error)
      }
    }
    if (
      holder !== null &&
      !holder.isEmailConfirmed &&
      holder.id !== operation.callerUserId &&
      (await this.isOpenWithoutAddress(holder))
    ) {
      logger.info('Confirm email refused: the address is held by an account that the request is not from', {
        userId: holder.id,
      })
      return { success: false, error: ConfirmEmailOperationErrorCode.CODE_INVALID }
    }

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

    if (holder === null) {
      logger.info('Confirm email: user disappeared after a valid code')
      return { success: false, error: ConfirmEmailOperationErrorCode.EMAIL_ALREADY_CONFIRMED }
    }
    if (holder.isEmailConfirmed) {
      return { success: false, error: ConfirmEmailOperationErrorCode.EMAIL_ALREADY_CONFIRMED }
    }

    // With a confirmed address the account has a way in that needs no device: its password. The
    // device keys are forgotten with it, otherwise signing out of a shared phone would not sign
    // anyone out, since the key left on it would open the account again.
    const userId = holder.id
    const refusal = await inTransaction(async (): Promise<ConfirmEmailOperationErrorCode | null> => {
      const marked = await usersManager.execute(new MarkUserEmailConfirmedCommand({ userId, email: input.email }))
      if (!marked.success) {
        switch (marked.error) {
          case MarkUserEmailConfirmedCommandErrorCode.USER_NOT_FOUND:
            throw new Error('User disappeared between lookup and email confirmation')
          // The address left the account (a registration took it) after the code was checked.
          case MarkUserEmailConfirmedCommandErrorCode.EMAIL_MISMATCH:
            return ConfirmEmailOperationErrorCode.CODE_INVALID
          default:
            return assertNever(marked.error)
        }
      }
      await userDevicesManager.execute(new DeleteUserDevicesCommand({ userId }))
      return null
    })
    if (refusal !== null) {
      logger.info('Confirm email: the address left the account before it was marked', { userId })
      return { success: false, error: refusal }
    }
    logger.info('Email confirmed', { userId })
    return { success: true, userId }
  }

  /**
   * A guest or Telegram account: a device key or a Telegram sign-in opens it without any address, so
   * it has been signed in and can hold a person's data. A registration that was never confirmed has
   * neither.
   */
  private async isOpenWithoutAddress(user: UserDTO): Promise<boolean> {
    if (user.telegramId !== null) return true
    const { hasDevices } = await userDevicesManager.execute(new HasUserDevicesQuery({ userId: user.id }))
    return hasDevices
  }
}
