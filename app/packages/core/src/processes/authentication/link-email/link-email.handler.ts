import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { addMinutes, createLogger, inTransaction, validateInput } from '../../../shared'
import { isDisposableEmailDomain } from '../../../config'
import {
  ChangeUserEmailCommand,
  ChangeUserEmailCommandErrorCode,
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  usersManager,
} from '../../../managers/users-manager'
import {
  GetUserCredentialsQuery,
  GetUserCredentialsQueryErrorCode,
  StoreUserCredentialsCommand,
  StoreUserCredentialsCommandErrorCode,
  UpdateUserCredentialsCommand,
  UpdateUserCredentialsCommandErrorCode,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import {
  CreateEmailCodeCommand,
  DeleteEmailCodesCommand,
  emailCodesManager,
} from '../../../managers/email-codes-manager'
import { HashPasswordRequest, passwordService } from '../../../services/password-service'
import { CreateNumericCodeRequest, tokenService } from '../../../services/token-service'
import { emailRendererService, RenderWelcomeEmailRequest } from '../../../services/email-renderer-service'
import { emailSenderService, SendEmailRequest } from '../../../services/email-sender-service'
import { PROCESSES_CONFIG } from '../../config'
import { LinkEmailOperation } from './link-email.operation'
import { LinkEmailOperationErrorCode, type LinkEmailResult } from './link-email.types'
import { linkEmailSchema } from './link-email.validator'

/**
 * An anonymous account gets an address and a password, and with them an ordinary way to sign in on
 * another device. The address is only a claim until the code from the email is entered (the same
 * `confirm-email` that follows registration); until then the account keeps working as it was and
 * email sign-in stays closed, because the address is not confirmed.
 *
 * An address that belongs to another account is EMAIL_TAKEN, whether that account is confirmed or
 * not. Registration lets the real owner reclaim an address parked by someone else, but here that
 * would mean taking over an account that may hold data, so the person registers normally instead.
 * An account whose address is still unconfirmed may ask again with another (a typo), which
 * replaces it; a confirmed address is final here.
 *
 * A failed email does not cancel the linking: the code can be requested again.
 */
@requestHandler(LinkEmailOperation)
export class LinkEmailOperationHandler implements RequestHandler<LinkEmailOperation, LinkEmailResult> {
  async handle(operation: LinkEmailOperation): Promise<LinkEmailResult> {
    const logger = createLogger('authentication')
    const input = validateInput(linkEmailSchema, { email: operation.email, password: operation.password })
    if (isDisposableEmailDomain(input.email)) {
      return { success: false, error: LinkEmailOperationErrorCode.DISPOSABLE_EMAIL }
    }

    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: LinkEmailOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: LinkEmailOperationErrorCode.USER_NOT_FOUND }
    if (!user.isActive) return { success: false, error: LinkEmailOperationErrorCode.USER_INACTIVE }
    if (user.email !== null && user.isEmailConfirmed) {
      return { success: false, error: LinkEmailOperationErrorCode.ALREADY_HAS_EMAIL }
    }

    const { passwordHash } = await passwordService.execute(
      new HashPasswordRequest({ password: input.password }),
    )
    const { code, codeHash } = await tokenService.execute(new CreateNumericCodeRequest())
    const expiresInMinutes = PROCESSES_CONFIG.CODES.TTL_MINUTES

    const failure = await inTransaction(async (): Promise<LinkEmailOperationErrorCode | null> => {
      const changed = await usersManager.execute(
        new ChangeUserEmailCommand({ userId: user.id, email: input.email }),
      )
      if (!changed.success) {
        switch (changed.error) {
          case ChangeUserEmailCommandErrorCode.EMAIL_ALREADY_TAKEN:
            return LinkEmailOperationErrorCode.EMAIL_TAKEN
          case ChangeUserEmailCommandErrorCode.USER_NOT_FOUND:
            return LinkEmailOperationErrorCode.USER_NOT_FOUND
          default:
            assertNever(changed.error)
        }
      }

      // The password goes next to the address: it is what email sign-in checks.
      const existing = await userCredentialsManager.execute(new GetUserCredentialsQuery({ userId: user.id }))
      if (existing.success) {
        const updated = await userCredentialsManager.execute(
          new UpdateUserCredentialsCommand({ userId: user.id, passwordHash }),
        )
        if (!updated.success) {
          switch (updated.error) {
            case UpdateUserCredentialsCommandErrorCode.CREDENTIALS_NOT_FOUND:
              throw new Error('Credentials vanished between read and update')
            default:
              assertNever(updated.error)
          }
        }
      } else {
        switch (existing.error) {
          case GetUserCredentialsQueryErrorCode.CREDENTIALS_NOT_FOUND: {
            const stored = await userCredentialsManager.execute(
              new StoreUserCredentialsCommand({ credentialsId: randomUUID(), userId: user.id, passwordHash }),
            )
            if (!stored.success) {
              switch (stored.error) {
                case StoreUserCredentialsCommandErrorCode.CREDENTIALS_ALREADY_EXIST:
                  throw new Error('Credentials appeared between read and insert')
                default:
                  assertNever(stored.error)
              }
            }
            break
          }
          default:
            assertNever(existing.error)
        }
      }

      // The address this one replaces (a typo) must not stay confirmable by an old code.
      if (user.email !== null && user.email !== input.email) {
        await emailCodesManager.execute(new DeleteEmailCodesCommand({ email: user.email }))
      }
      await emailCodesManager.execute(
        new CreateEmailCodeCommand({
          codeId: randomUUID(),
          email: input.email,
          purpose: 'confirm_email',
          codeHash,
          expiresAt: addMinutes(new Date(), expiresInMinutes),
        }),
      )
      return null
    })
    if (failure) return { success: false, error: failure }

    try {
      const { email } = await emailRendererService.execute(
        new RenderWelcomeEmailRequest({ userName: user.name, code, expiresInMinutes }),
      )
      await emailSenderService.execute(new SendEmailRequest({ to: input.email, ...email }))
    } catch (error) {
      logger.error('Failed to send the confirmation email', error, { userId: user.id })
    }
    logger.info('Email linked, waiting for confirmation', { userId: user.id })
    return { success: true, email: input.email }
  }
}
