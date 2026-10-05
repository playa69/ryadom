import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { addMinutes, createLogger, validateInput } from '../../../shared'
import { GetUserByEmailQuery, GetUserByEmailQueryErrorCode, usersManager } from '../../../managers/users-manager'
import { CreateEmailCodeCommand, emailCodesManager } from '../../../managers/email-codes-manager'
import { CreateNumericCodeRequest, tokenService } from '../../../services/token-service'
import {
  emailRendererService,
  RenderEmailConfirmationEmailRequest,
} from '../../../services/email-renderer-service'
import { emailSenderService, SendEmailRequest } from '../../../services/email-sender-service'
import { PROCESSES_CONFIG } from '../../config'
import { ResendConfirmationOperation } from './resend-confirmation.operation'
import type { ResendConfirmationResult } from './resend-confirmation.types'
import { resendConfirmationSchema } from './resend-confirmation.validator'

/**
 * A repeat confirmation code. The response is always "ok": it cannot reveal whether the
 * account exists. The code is sent only if the email is not confirmed yet and is valid for
 * 10 minutes; the previous one is burned.
 */
@requestHandler(ResendConfirmationOperation)
export class ResendConfirmationOperationHandler
  implements RequestHandler<ResendConfirmationOperation, ResendConfirmationResult>
{
  async handle(operation: ResendConfirmationOperation): Promise<ResendConfirmationResult> {
    const logger = createLogger('email-confirmation')
    const input = validateInput(resendConfirmationSchema, { email: operation.email })

    const userResult = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
          logger.info('Resend confirmation: no such user')
          return { success: true }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isEmailConfirmed) {
      logger.info('Resend confirmation: email already confirmed', { userId: user.id })
      return { success: true }
    }

    const { code, codeHash } = await tokenService.execute(new CreateNumericCodeRequest())
    const expiresInMinutes = PROCESSES_CONFIG.CODES.TTL_MINUTES
    await emailCodesManager.execute(
      new CreateEmailCodeCommand({
        codeId: randomUUID(),
        email: input.email,
        purpose: 'confirm_email',
        codeHash,
        expiresAt: addMinutes(new Date(), expiresInMinutes),
      }),
    )
    const { email } = await emailRendererService.execute(
      new RenderEmailConfirmationEmailRequest({ userName: user.name, code, expiresInMinutes }),
    )
    await emailSenderService.execute(new SendEmailRequest({ to: input.email, ...email }))
    logger.info('Confirmation code sent', { userId: user.id })
    return { success: true }
  }
}
