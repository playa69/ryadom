import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { addMinutes, createLogger, inTransaction, validateInput } from '../../../shared'
import { isDisposableEmailDomain } from '../../../config'
import {
  CreateUserCommand,
  CreateUserCommandErrorCode,
  GetUserByEmailQuery,
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  UpdateUserNameCommand,
  usersManager,
  type UserDTO,
} from '../../../managers/users-manager'
import {
  StoreUserCredentialsCommand,
  StoreUserCredentialsCommandErrorCode,
  UpdateUserCredentialsCommand,
  UpdateUserCredentialsCommandErrorCode,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import { CreateEmailCodeCommand, emailCodesManager } from '../../../managers/email-codes-manager'
import { HashPasswordRequest, passwordService } from '../../../services/password-service'
import { CreateNumericCodeRequest, tokenService } from '../../../services/token-service'
import { emailRendererService, RenderWelcomeEmailRequest } from '../../../services/email-renderer-service'
import { emailSenderService, SendEmailRequest } from '../../../services/email-sender-service'
import { PROCESSES_CONFIG } from '../../config'
import { RegisterOperation } from './register.operation'
import { RegisterOperationErrorCode, type RegisterResult } from './register.types'
import { registerSchema } from './register.validator'

/**
 * Registration by email and password: an account with an unconfirmed email, a password, a
 * confirmation code valid for 10 minutes, and a welcome email carrying that code.
 * Signing in is only possible once the email is confirmed. A failed email does not cancel the
 * registration, the code can be requested again.
 *
 * An address that was registered but never confirmed is not taken: whoever registers it again
 * (the real owner, after a lost or expired code) gets their name and password stored in place of
 * the earlier ones and a fresh code. Otherwise anyone could park a stranger's address with a
 * password of their own, and the owner could neither register nor sign in, and could not even
 * confirm it safely, since the account would hold someone else's password.
 */
@requestHandler(RegisterOperation)
export class RegisterOperationHandler implements RequestHandler<RegisterOperation, RegisterResult> {
  async handle(operation: RegisterOperation): Promise<RegisterResult> {
    const logger = createLogger('authentication')
    const input = validateInput(registerSchema, {
      email: operation.email,
      password: operation.password,
      name: operation.name,
    })
    if (isDisposableEmailDomain(input.email)) {
      return { success: false, error: RegisterOperationErrorCode.DISPOSABLE_EMAIL }
    }

    const { passwordHash } = await passwordService.execute(new HashPasswordRequest({ password: input.password }))
    const { code, codeHash } = await tokenService.execute(new CreateNumericCodeRequest())
    const expiresInMinutes = PROCESSES_CONFIG.CODES.TTL_MINUTES
    let userId: string = randomUUID()

    const outcome = await inTransaction(async (): Promise<UserDTO | RegisterOperationErrorCode> => {
      const created = await usersManager.execute(
        new CreateUserCommand({ userId, email: input.email, name: input.name, isEmailConfirmed: false }),
      )
      if (created.success) {
        const stored = await userCredentialsManager.execute(
          new StoreUserCredentialsCommand({ credentialsId: randomUUID(), userId, passwordHash }),
        )
        if (!stored.success) {
          switch (stored.error) {
            case StoreUserCredentialsCommandErrorCode.CREDENTIALS_ALREADY_EXIST:
              throw new Error('Credentials of a just created user already exist')
            default:
              assertNever(stored.error)
          }
        }
      } else {
        switch (created.error) {
          case CreateUserCommandErrorCode.USER_ALREADY_EXISTS: {
            const existing = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
            if (!existing.success) return RegisterOperationErrorCode.USER_ALREADY_EXISTS
            const { user } = existing
            // A confirmed, blocked or deleted account keeps its address.
            if (user.isEmailConfirmed || !user.isActive || user.isDeleted) {
              return RegisterOperationErrorCode.USER_ALREADY_EXISTS
            }
            userId = user.id
            const renamed = await usersManager.execute(new UpdateUserNameCommand({ userId, name: input.name }))
            if (!renamed.success) return RegisterOperationErrorCode.USER_ALREADY_EXISTS
            const updated = await userCredentialsManager.execute(
              new UpdateUserCredentialsCommand({ userId, passwordHash }),
            )
            if (!updated.success) {
              switch (updated.error) {
                case UpdateUserCredentialsCommandErrorCode.CREDENTIALS_NOT_FOUND:
                  throw new Error('Credentials of an unconfirmed user are missing')
                default:
                  assertNever(updated.error)
              }
            }
            break
          }
          default:
            assertNever(created.error)
        }
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

      const userResult = await usersManager.execute(new GetUserByIdQuery({ userId }))
      if (!userResult.success) {
        switch (userResult.error) {
          case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
            throw new Error('Just created user not found')
          default:
            assertNever(userResult.error)
        }
      }
      return userResult.user
    })
    if (typeof outcome === 'string') return { success: false, error: outcome }

    try {
      const { email } = await emailRendererService.execute(
        new RenderWelcomeEmailRequest({ userName: outcome.name, code, expiresInMinutes }),
      )
      await emailSenderService.execute(new SendEmailRequest({ to: outcome.email, ...email }))
    } catch (error) {
      logger.error('Failed to send welcome email', error, { userId })
    }
    logger.info('User registered', { userId })
    return { success: true, user: outcome }
  }
}
