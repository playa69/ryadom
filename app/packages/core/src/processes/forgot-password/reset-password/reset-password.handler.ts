import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction, validateInput } from '../../../shared'
import { GetUserByEmailQuery, GetUserByEmailQueryErrorCode, usersManager } from '../../../managers/users-manager'
import {
  emailCodesManager,
  VerifyEmailCodeCommand,
  VerifyEmailCodeCommandErrorCode,
} from '../../../managers/email-codes-manager'
import {
  StoreUserCredentialsCommand,
  StoreUserCredentialsCommandErrorCode,
  UpdateUserCredentialsCommand,
  UpdateUserCredentialsCommandErrorCode,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import {
  RevokeUserRefreshTokensCommand,
  refreshTokensManager,
} from '../../../managers/refresh-tokens-manager'
import { HashPasswordRequest, passwordService } from '../../../services/password-service'
import { HashTokenRequest, tokenService } from '../../../services/token-service'
import { ResetPasswordOperation } from './reset-password.operation'
import { ResetPasswordOperationErrorCode, type ResetPasswordResult } from './reset-password.types'
import { resetPasswordSchema } from './reset-password.validator'

/**
 * A new password from the code in the email: the code and the password arrive in
 * one form, there is no separate "check the link" screen. A wrong or expired code gives
 * CODE_INVALID, the fifth error in a row gives TOO_MANY_ATTEMPTS, and a blocked account gives
 * USER_INACTIVE. The password row may be missing (corrupted data), in which case it is created.
 * Every session ends: the person who resets a password has lost it, or somebody else has it.
 */
@requestHandler(ResetPasswordOperation)
export class ResetPasswordOperationHandler implements RequestHandler<ResetPasswordOperation, ResetPasswordResult> {
  async handle(operation: ResetPasswordOperation): Promise<ResetPasswordResult> {
    const input = validateInput(resetPasswordSchema, {
      email: operation.email,
      code: operation.code,
      newPassword: operation.newPassword,
    })
    const { tokenHash: codeHash } = await tokenService.execute(new HashTokenRequest({ token: input.code }))

    const verified = await emailCodesManager.execute(
      new VerifyEmailCodeCommand({ email: input.email, purpose: 'reset_password', codeHash }),
    )
    if (!verified.success) {
      switch (verified.error) {
        case VerifyEmailCodeCommandErrorCode.CODE_NOT_FOUND:
        case VerifyEmailCodeCommandErrorCode.CODE_MISMATCH:
          return { success: false, error: ResetPasswordOperationErrorCode.CODE_INVALID }
        case VerifyEmailCodeCommandErrorCode.TOO_MANY_ATTEMPTS:
          return { success: false, error: ResetPasswordOperationErrorCode.TOO_MANY_ATTEMPTS }
        default:
          return assertNever(verified.error)
      }
    }

    const userResult = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
          // The code was genuine but the account is already gone: the same rejection as for a
          // wrong code.
          return { success: false, error: ResetPasswordOperationErrorCode.CODE_INVALID }
        default:
          return assertNever(userResult.error)
      }
    }
    const userId = userResult.user.id
    if (userResult.user.isDeleted) return { success: false, error: ResetPasswordOperationErrorCode.CODE_INVALID }
    if (!userResult.user.isActive) return { success: false, error: ResetPasswordOperationErrorCode.USER_INACTIVE }

    const { passwordHash } = await passwordService.execute(new HashPasswordRequest({ password: input.newPassword }))
    await inTransaction(async (): Promise<void> => {
      await refreshTokensManager.execute(
        new RevokeUserRefreshTokensCommand({ userId, exceptSessionId: null, revokedAt: new Date() }),
      )
      const updated = await userCredentialsManager.execute(new UpdateUserCredentialsCommand({ userId, passwordHash }))
      if (updated.success) return
      switch (updated.error) {
        case UpdateUserCredentialsCommandErrorCode.CREDENTIALS_NOT_FOUND:
          break
        default:
          assertNever(updated.error)
      }
      const stored = await userCredentialsManager.execute(
        new StoreUserCredentialsCommand({ credentialsId: randomUUID(), userId, passwordHash }),
      )
      if (!stored.success) {
        switch (stored.error) {
          case StoreUserCredentialsCommandErrorCode.CREDENTIALS_ALREADY_EXIST:
            throw new Error('Credentials appeared between update and insert')
          default:
            assertNever(stored.error)
        }
      }
    })
    createLogger('forgot-password').info('Password reset', { userId })
    return { success: true }
  }
}
