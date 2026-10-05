import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { addMinutes, createLogger, validateInput } from '../../../shared'
import { GetUserByEmailQuery, GetUserByEmailQueryErrorCode, usersManager } from '../../../managers/users-manager'
import { CreateEmailCodeCommand, emailCodesManager } from '../../../managers/email-codes-manager'
import { CreateNumericCodeRequest, tokenService } from '../../../services/token-service'
import { emailRendererService, RenderForgotPasswordEmailRequest } from '../../../services/email-renderer-service'
import { emailSenderService, SendEmailRequest } from '../../../services/email-sender-service'
import { PROCESSES_CONFIG } from '../../config'
import { ForgotPasswordOperation } from './forgot-password.operation'
import type { ForgotPasswordResult } from './forgot-password.types'
import { forgotPasswordSchema } from './forgot-password.validator'

/**
 * "I forgot my password". The response is always "ok": otherwise the form would
 * become a way to check whether a person is registered. The code is sent only to an active
 * account with a confirmed email, is valid for 10 minutes, and every request issues a new one
 * while burning the previous one.
 */
@requestHandler(ForgotPasswordOperation)
export class ForgotPasswordOperationHandler
  implements RequestHandler<ForgotPasswordOperation, ForgotPasswordResult>
{
  async handle(operation: ForgotPasswordOperation): Promise<ForgotPasswordResult> {
    const logger = createLogger('forgot-password')
    const input = validateInput(forgotPasswordSchema, { email: operation.email })

    const userResult = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
          logger.info('Forgot password: no such user')
          return { success: true }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted || !user.isActive) {
      logger.info('Forgot password: account unavailable', { userId: user.id })
      return { success: true }
    }
    if (!user.isEmailConfirmed) {
      // There is no password to change: the account is not confirmed yet and needs an email
      // confirmation code.
      logger.info('Forgot password: email not confirmed', { userId: user.id })
      return { success: true }
    }

    const { code, codeHash } = await tokenService.execute(new CreateNumericCodeRequest())
    const expiresInMinutes = PROCESSES_CONFIG.CODES.TTL_MINUTES
    await emailCodesManager.execute(
      new CreateEmailCodeCommand({
        codeId: randomUUID(),
        email: input.email,
        purpose: 'reset_password',
        codeHash,
        expiresAt: addMinutes(new Date(), expiresInMinutes),
      }),
    )
    const { email } = await emailRendererService.execute(
      new RenderForgotPasswordEmailRequest({ userName: user.name, code, expiresInMinutes }),
    )
    await emailSenderService.execute(new SendEmailRequest({ to: input.email, ...email }))
    logger.info('Password reset code sent', { userId: user.id })
    return { success: true }
  }
}
