import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { addMinutes, createLogger, validateInput } from '../../../shared'
import { getEnv, isAdminEmail } from '../../../config'
import { CreateEmailCodeCommand, emailCodesManager } from '../../../managers/email-codes-manager'
import { CreateNumericCodeRequest, tokenService } from '../../../services/token-service'
import { emailRendererService, RenderAdminCodeEmailRequest } from '../../../services/email-renderer-service'
import { emailSenderService, SendEmailRequest } from '../../../services/email-sender-service'
import { PROCESSES_CONFIG } from '../../config'
import { RequestAdminCodeOperation } from './request-admin-code.operation'
import type { RequestAdminCodeResult } from './request-admin-code.types'
import { requestAdminCodeSchema } from './request-admin-code.validator'

/**
 * Sign-in code for the admin panel. The response is always "ok" and the email is
 * sent only to an address from `ADMIN_EMAILS`: otherwise the sign-in form would become a way
 * to learn who on the team is an admin.
 *
 * Admin rights come from the config only, so the check is against that list rather than
 * against data in the database.
 */
@requestHandler(RequestAdminCodeOperation)
export class RequestAdminCodeOperationHandler
  implements RequestHandler<RequestAdminCodeOperation, RequestAdminCodeResult>
{
  async handle(operation: RequestAdminCodeOperation): Promise<RequestAdminCodeResult> {
    const logger = createLogger('admin-authentication')
    const input = validateInput(requestAdminCodeSchema, { email: operation.email })

    if (!isAdminEmail(getEnv(), input.email)) {
      logger.info('Admin code refused: email is not in ADMIN_EMAILS')
      return { success: true }
    }

    const { code, codeHash } = await tokenService.execute(new CreateNumericCodeRequest())
    const expiresInMinutes = PROCESSES_CONFIG.CODES.TTL_MINUTES
    await emailCodesManager.execute(
      new CreateEmailCodeCommand({
        codeId: randomUUID(),
        email: input.email,
        purpose: 'admin_sign_in',
        codeHash,
        expiresAt: addMinutes(new Date(), expiresInMinutes),
      }),
    )
    const { email } = await emailRendererService.execute(
      new RenderAdminCodeEmailRequest({ code, expiresInMinutes }),
    )
    await emailSenderService.execute(new SendEmailRequest({ to: input.email, ...email }))
    logger.info('Admin sign-in code sent')
    return { success: true }
  }
}
