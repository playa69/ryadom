import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, validateInput } from '../../../shared'
import { getEnv, isAdminEmail } from '../../../config'
import {
  emailCodesManager,
  VerifyEmailCodeCommand,
  VerifyEmailCodeCommandErrorCode,
} from '../../../managers/email-codes-manager'
import { HashTokenRequest, tokenService } from '../../../services/token-service'
import { ConfirmAdminCodeOperation } from './confirm-admin-code.operation'
import { ConfirmAdminCodeOperationErrorCode, type ConfirmAdminCodeResult } from './confirm-admin-code.types'
import { confirmAdminCodeSchema } from './confirm-admin-code.validator'

/**
 * The code is confirmed, so the email is proven and the admin panel builds its own cookie
 * session from it. The list is checked again: the email could have been removed
 * from `ADMIN_EMAILS` between issuing the code and entering it, and then signing in is no
 * longer allowed even with a correct code.
 */
@requestHandler(ConfirmAdminCodeOperation)
export class ConfirmAdminCodeOperationHandler
  implements RequestHandler<ConfirmAdminCodeOperation, ConfirmAdminCodeResult>
{
  async handle(operation: ConfirmAdminCodeOperation): Promise<ConfirmAdminCodeResult> {
    const logger = createLogger('admin-authentication')
    const input = validateInput(confirmAdminCodeSchema, { email: operation.email, code: operation.code })
    const { tokenHash: codeHash } = await tokenService.execute(new HashTokenRequest({ token: input.code }))

    const verified = await emailCodesManager.execute(
      new VerifyEmailCodeCommand({ email: input.email, purpose: 'admin_sign_in', codeHash }),
    )
    if (!verified.success) {
      switch (verified.error) {
        case VerifyEmailCodeCommandErrorCode.CODE_NOT_FOUND:
        case VerifyEmailCodeCommandErrorCode.CODE_MISMATCH:
          return { success: false, error: ConfirmAdminCodeOperationErrorCode.CODE_INVALID }
        case VerifyEmailCodeCommandErrorCode.TOO_MANY_ATTEMPTS:
          return { success: false, error: ConfirmAdminCodeOperationErrorCode.TOO_MANY_ATTEMPTS }
        default:
          return assertNever(verified.error)
      }
    }

    if (!isAdminEmail(getEnv(), input.email)) {
      logger.warn('Admin sign-in refused: email removed from ADMIN_EMAILS after the code was issued')
      return { success: false, error: ConfirmAdminCodeOperationErrorCode.NOT_ADMIN }
    }
    logger.info('Admin signed in')
    return { success: true, email: input.email }
  }
}
