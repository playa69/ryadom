import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, validateInput } from '../../../shared'
import { GetUserByEmailQuery, GetUserByEmailQueryErrorCode, usersManager } from '../../../managers/users-manager'
import {
  GetUserCredentialsQuery,
  GetUserCredentialsQueryErrorCode,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import { passwordService, VerifyPasswordRequest } from '../../../services/password-service'
import { LoginOperation } from './login.operation'
import { LoginOperationErrorCode, type LoginResult } from './login.types'
import { loginSchema } from './login.validator'

/**
 * Sign-in by email and password. Order of the checks: no account or a deleted
 * one gives INVALID_CREDENTIALS; a wrong password gives INVALID_CREDENTIALS; and only after a
 * correct password come USER_INACTIVE (blocked) and EMAIL_NOT_CONFIRMED. That way the response
 * cannot reveal whether an account with this address exists: the application answers with the
 * same 401 anyway, but the core does not have to distinguish more than it needs to.
 *
 * There are no external sign-in providers, so every live account has a password:
 * a missing one is corrupted data rather than a scenario, and for the person it means the same
 * invalid credentials.
 */
@requestHandler(LoginOperation)
export class LoginOperationHandler implements RequestHandler<LoginOperation, LoginResult> {
  async handle(operation: LoginOperation): Promise<LoginResult> {
    const logger = createLogger('authentication')
    const input = validateInput(loginSchema, { email: operation.email, password: operation.password })

    const userResult = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: LoginOperationErrorCode.INVALID_CREDENTIALS }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    // A deleted account is indistinguishable from one that never existed.
    if (user.isDeleted) return { success: false, error: LoginOperationErrorCode.INVALID_CREDENTIALS }

    const credentials = await userCredentialsManager.execute(new GetUserCredentialsQuery({ userId: user.id }))
    if (!credentials.success) {
      switch (credentials.error) {
        case GetUserCredentialsQueryErrorCode.CREDENTIALS_NOT_FOUND:
          logger.warn('Login refused: account without password', undefined, { userId: user.id })
          return { success: false, error: LoginOperationErrorCode.INVALID_CREDENTIALS }
        default:
          assertNever(credentials.error)
      }
    }

    const { isValid } = await passwordService.execute(
      new VerifyPasswordRequest({ password: input.password, passwordHash: credentials.credentials.passwordHash }),
    )
    if (!isValid) {
      logger.info('Login refused: invalid password', { userId: user.id })
      return { success: false, error: LoginOperationErrorCode.INVALID_CREDENTIALS }
    }
    if (!user.isActive) {
      logger.info('Login refused: user inactive', { userId: user.id })
      return { success: false, error: LoginOperationErrorCode.USER_INACTIVE }
    }
    if (!user.isEmailConfirmed) {
      logger.info('Login refused: email not confirmed', { userId: user.id })
      return { success: false, error: LoginOperationErrorCode.EMAIL_NOT_CONFIRMED }
    }
    logger.info('User logged in', { userId: user.id })
    return { success: true, user }
  }
}
