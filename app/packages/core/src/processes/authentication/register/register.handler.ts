import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { addMinutes, createLogger, inTransaction, validateInput } from '../../../shared'
import { isDisposableEmailDomain } from '../../../config'
import {
  CreateUserCommand,
  CreateUserCommandErrorCode,
  GetUserByEmailQuery,
  GetUserByEmailQueryErrorCode,
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  ReleaseUserEmailCommand,
  ReleaseUserEmailCommandErrorCode,
  UpdateUserNameCommand,
  UpdateUserNameCommandErrorCode,
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
import { HasUserDevicesQuery, userDevicesManager } from '../../../managers/user-devices-manager'
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
 * Concurrent registrations of one address make a decision stale between reading and writing, so the
 * attempt to get the address is made again, a few times, before giving up.
 */
const MAX_CLAIM_ATTEMPTS = 4

type Claim = { kind: 'ready'; userId: string } | { kind: 'refused' } | { kind: 'again' }

/**
 * Registration by email and password: an account with an unconfirmed email, a password, a
 * confirmation code valid for 10 minutes, and a welcome email carrying that code.
 * Signing in is only possible once the email is confirmed. A failed email does not cancel the
 * registration, the code can be requested again.
 *
 * An address that is held but never confirmed is not final, because nobody has proven it yet; but
 * what happens to the holder depends on whether it is a person's account:
 * - a registration nobody has signed in with (no device, no Telegram) has nothing in it. Whoever
 *   registers the address again (the real owner, after a lost or expired code) gets their name and
 *   password stored in place of the earlier ones and a fresh code. Otherwise anyone could park a
 *   stranger's address with a password of their own;
 * - a guest or Telegram account that typed the address (maybe with a typo) is somebody's account
 *   with their conversations and memory. It is never rewritten: the address is taken off it, the
 *   account stays as it was, a guest without an address, and the new account is a separate one.
 *   Owning the mailbox earns the address, not another person's account.
 * The answer is the same in both cases, so it does not tell who holds an address.
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

    const outcome = await inTransaction(async (): Promise<UserDTO | RegisterOperationErrorCode> => {
      let userId: string | null = null
      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS && userId === null; attempt++) {
        const claim = await this.claimAddress(input, passwordHash)
        switch (claim.kind) {
          case 'ready':
            userId = claim.userId
            break
          case 'refused':
            return RegisterOperationErrorCode.USER_ALREADY_EXISTS
          case 'again':
            break
          default:
            assertNever(claim)
        }
      }
      if (userId === null) return RegisterOperationErrorCode.USER_ALREADY_EXISTS

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
      await emailSenderService.execute(new SendEmailRequest({ to: input.email, ...email }))
    } catch (error) {
      logger.error('Failed to send welcome email', error, { userId: outcome.id })
    }
    logger.info('User registered', { userId: outcome.id })
    return { success: true, user: outcome }
  }

  /** One try at getting the address for the account of the person who registers; runs inside the transaction. */
  private async claimAddress(input: { email: string; name: string }, passwordHash: string): Promise<Claim> {
    const logger = createLogger('authentication')
    const userId = randomUUID()
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
      return { kind: 'ready', userId }
    }
    switch (created.error) {
      case CreateUserCommandErrorCode.USER_ALREADY_EXISTS:
        break
      default:
        assertNever(created.error)
    }

    const existing = await usersManager.execute(new GetUserByEmailQuery({ email: input.email }))
    if (!existing.success) {
      switch (existing.error) {
        // The holder went away between the insert and the read: try the insert again.
        case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
          return { kind: 'again' }
        default:
          assertNever(existing.error)
      }
    }
    const { user } = existing
    // A confirmed, blocked or deleted account keeps its address.
    if (user.isEmailConfirmed || !user.isActive || user.isDeleted) return { kind: 'refused' }

    if (await this.isOpenWithoutAddress(user)) {
      const released = await usersManager.execute(new ReleaseUserEmailCommand({ userId: user.id, email: input.email }))
      if (!released.success) {
        switch (released.error) {
          // Confirmed or moved in the meantime: look at the new state.
          case ReleaseUserEmailCommandErrorCode.ADDRESS_NOT_HELD:
            return { kind: 'again' }
          default:
            assertNever(released.error)
        }
      }
      logger.info('Register: address taken off an account that is in use', { userId: user.id })
      return { kind: 'again' }
    }

    // Nobody has signed in with this registration, so there is nothing of a person's in it.
    const renamed = await usersManager.execute(new UpdateUserNameCommand({ userId: user.id, name: input.name }))
    if (!renamed.success) {
      switch (renamed.error) {
        case UpdateUserNameCommandErrorCode.USER_NOT_FOUND:
          return { kind: 'again' }
        default:
          assertNever(renamed.error)
      }
    }
    const updated = await userCredentialsManager.execute(
      new UpdateUserCredentialsCommand({ userId: user.id, passwordHash }),
    )
    if (!updated.success) {
      switch (updated.error) {
        case UpdateUserCredentialsCommandErrorCode.CREDENTIALS_NOT_FOUND:
          throw new Error('Credentials of an unconfirmed user are missing')
        default:
          assertNever(updated.error)
      }
    }
    return { kind: 'ready', userId: user.id }
  }

  /**
   * A guest or Telegram account: a device key or a Telegram sign-in opens it without any address, so
   * it has been signed in and can hold conversations and memory. A registration that was never
   * confirmed has neither.
   */
  private async isOpenWithoutAddress(user: UserDTO): Promise<boolean> {
    if (user.telegramId !== null) return true
    const { hasDevices } = await userDevicesManager.execute(new HasUserDevicesQuery({ userId: user.id }))
    return hasDevices
  }
}
