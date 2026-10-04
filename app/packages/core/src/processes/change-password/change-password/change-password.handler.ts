import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction, validateInput } from '../../../shared'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'
import {
  GetUserCredentialsQuery,
  GetUserCredentialsQueryErrorCode,
  UpdateUserCredentialsCommand,
  UpdateUserCredentialsCommandErrorCode,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import {
  RevokeUserRefreshTokensCommand,
  refreshTokensManager,
} from '../../../managers/refresh-tokens-manager'
import { HashPasswordRequest, passwordService, VerifyPasswordRequest } from '../../../services/password-service'
import {
  emailRendererService,
  RenderPasswordChangedEmailRequest,
} from '../../../services/email-renderer-service'
import { emailSenderService, SendEmailRequest } from '../../../services/email-sender-service'
import { ChangePasswordOperation } from './change-password.operation'
import { ChangePasswordOperationErrorCode, type ChangePasswordResult } from './change-password.types'
import { changePasswordSchema } from './change-password.validator'

/**
 * Password change using the current password. No account, a deleted one, or one without a
 * password gives USER_NOT_FOUND (an account without a password needs to set one instead).
 * The other sessions end together with the old password: a password changed because someone else
 * knew it must not leave that someone signed in. After the change a "password changed" email is
 * sent, and its failure does not cancel the change.
 */
@requestHandler(ChangePasswordOperation)
export class ChangePasswordOperationHandler implements RequestHandler<ChangePasswordOperation, ChangePasswordResult> {
  async handle(operation: ChangePasswordOperation): Promise<ChangePasswordResult> {
    const logger = createLogger('change-password')
    const input = validateInput(changePasswordSchema, {
      currentPassword: operation.currentPassword,
      newPassword: operation.newPassword,
    })

    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: ChangePasswordOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: ChangePasswordOperationErrorCode.USER_NOT_FOUND }

    const credentials = await userCredentialsManager.execute(new GetUserCredentialsQuery({ userId: user.id }))
    if (!credentials.success) {
      switch (credentials.error) {
        case GetUserCredentialsQueryErrorCode.CREDENTIALS_NOT_FOUND:
          return { success: false, error: ChangePasswordOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(credentials.error)
      }
    }
    const { isValid } = await passwordService.execute(
      new VerifyPasswordRequest({
        password: input.currentPassword,
        passwordHash: credentials.credentials.passwordHash,
      }),
    )
    if (!isValid) return { success: false, error: ChangePasswordOperationErrorCode.INVALID_CURRENT_PASSWORD }

    const { passwordHash } = await passwordService.execute(new HashPasswordRequest({ password: input.newPassword }))
    const failure = await inTransaction(async (): Promise<ChangePasswordOperationErrorCode | null> => {
      const updated = await userCredentialsManager.execute(
        new UpdateUserCredentialsCommand({ userId: user.id, passwordHash }),
      )
      if (!updated.success) {
        switch (updated.error) {
          case UpdateUserCredentialsCommandErrorCode.CREDENTIALS_NOT_FOUND:
            return ChangePasswordOperationErrorCode.USER_NOT_FOUND
          default:
            assertNever(updated.error)
        }
      }
      await refreshTokensManager.execute(
        new RevokeUserRefreshTokensCommand({
          userId: user.id,
          exceptSessionId: operation.keepSessionId,
          revokedAt: new Date(),
        }),
      )
      return null
    })
    if (failure) return { success: false, error: failure }

    // The password-change email cannot be turned off: it is the owner's signal if someone else
    // changed the password.
    // An account with a password always has an address (linking sets both); the check is for the type.
    if (user.email !== null) {
      try {
        const { email } = await emailRendererService.execute(
          new RenderPasswordChangedEmailRequest({ userName: user.name, changedAt: new Date() }),
        )
        await emailSenderService.execute(new SendEmailRequest({ to: user.email, ...email }))
      } catch (error) {
        logger.error('Failed to send password changed email', error, { userId: user.id })
      }
    }
    logger.info('Password changed', { userId: user.id })
    return { success: true }
  }
}
