import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  CreateUserCommand,
  CreateUserCommandErrorCode,
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  GetUserByTelegramIdQuery,
  GetUserByTelegramIdQueryErrorCode,
  usersManager,
  type UserDTO,
} from '../../../managers/users-manager'
import {
  telegramService,
  VerifyInitDataRequest,
  VerifyInitDataRequestErrorCode,
} from '../../../services/telegram-service'
import { recordActivity } from '../shared/record-activity'
import { TelegramLoginOperation } from './telegram-login.operation'
import { TelegramLoginOperationErrorCode, type TelegramLoginResult } from './telegram-login.types'

/**
 * Sign-in from the Telegram Mini App. Telegram vouches for who the person is: the launch data it signs
 * with the bot's key names their Telegram user, so there is nothing to type and no secret of ours on
 * the device. The account is the one this Telegram user is linked to, on any device they open the Mini
 * App on; a confirmed address does not stop it, because the Telegram account is the person's own.
 *
 * Unlike the device sign-in, a Telegram user that has no account gets one only when asked
 * (`createAccount`): the app asks from the first screen, after the agreements, so nothing about the
 * person is stored before they have agreed to it. Only the Telegram id is stored; the name from
 * Telegram stays a suggestion on the screen.
 */
@requestHandler(TelegramLoginOperation)
export class TelegramLoginOperationHandler implements RequestHandler<
  TelegramLoginOperation,
  TelegramLoginResult
> {
  async handle(operation: TelegramLoginOperation): Promise<TelegramLoginResult> {
    const logger = createLogger('authentication')
    const verified = await telegramService.execute(
      new VerifyInitDataRequest({ initData: operation.initData }),
    )
    if (!verified.success) {
      switch (verified.error) {
        case VerifyInitDataRequestErrorCode.NOT_CONFIGURED:
          return { success: false, error: TelegramLoginOperationErrorCode.NOT_CONFIGURED }
        case VerifyInitDataRequestErrorCode.INVALID:
          return { success: false, error: TelegramLoginOperationErrorCode.INIT_DATA_INVALID }
        case VerifyInitDataRequestErrorCode.EXPIRED:
          return { success: false, error: TelegramLoginOperationErrorCode.INIT_DATA_EXPIRED }
        default:
          return assertNever(verified.error)
      }
    }
    const telegramId = verified.telegramUser.id

    // Two goes: a first sign-in that loses the race for a Telegram id finds the winner on the second.
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await usersManager.execute(new GetUserByTelegramIdQuery({ telegramId }))
      if (found.success) return this.signIn(found.user)
      switch (found.error) {
        case GetUserByTelegramIdQueryErrorCode.USER_NOT_FOUND:
          break
        default:
          assertNever(found.error)
      }
      if (!operation.createAccount)
        return { success: false, error: TelegramLoginOperationErrorCode.ACCOUNT_NOT_FOUND }

      const user = await this.createAccount(telegramId)
      if (user) {
        logger.info('Telegram account created', { userId: user.id })
        return { success: true, user, isNewAccount: true }
      }
    }
    throw new Error('A Telegram id kept appearing and disappearing')
  }

  private async signIn(user: UserDTO): Promise<TelegramLoginResult> {
    const logger = createLogger('authentication')
    // Deleting an account drops its Telegram id, so this is only a guard against stale data.
    if (user.isDeleted) return { success: false, error: TelegramLoginOperationErrorCode.ACCOUNT_NOT_FOUND }
    if (!user.isActive) {
      logger.info('Telegram sign-in refused: user inactive', { userId: user.id })
      return { success: false, error: TelegramLoginOperationErrorCode.USER_INACTIVE }
    }
    await recordActivity(user.id)
    logger.info('Signed in with Telegram', { userId: user.id })
    return { success: true, user, isNewAccount: false }
  }

  /** null when another request made an account for this Telegram user first. */
  private async createAccount(telegramId: number): Promise<UserDTO | null> {
    const userId = randomUUID()
    const created = await usersManager.execute(
      new CreateUserCommand({ userId, email: null, name: null, isEmailConfirmed: false, telegramId }),
    )
    if (!created.success) {
      switch (created.error) {
        // Email is null, so the conflict is the Telegram id (or, beyond belief, the random user id).
        case CreateUserCommandErrorCode.USER_ALREADY_EXISTS:
          return null
        default:
          return assertNever(created.error)
      }
    }
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
  }
}
