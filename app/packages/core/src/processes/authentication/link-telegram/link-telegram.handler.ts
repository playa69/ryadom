import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  LinkUserTelegramCommand,
  LinkUserTelegramCommandErrorCode,
  usersManager,
} from '../../../managers/users-manager'
import {
  telegramService,
  VerifyInitDataRequest,
  VerifyInitDataRequestErrorCode,
} from '../../../services/telegram-service'
import { LinkTelegramOperation } from './link-telegram.operation'
import { LinkTelegramOperationErrorCode, type LinkTelegramResult } from './link-telegram.types'

/**
 * The signed-in account takes the Telegram user of the Mini App it is open in, so that the Mini App
 * opens this account from then on, without a password. The person who signed in by email inside
 * Telegram asks for it themselves (the app asks first: on someone else's phone it would hand the account
 * to the owner of that Telegram).
 *
 * A Telegram user that already has an account keeps it (TELEGRAM_TAKEN): accounts are never merged, and
 * one with conversations is not silently taken over. Linking the same pair again is a success.
 */
@requestHandler(LinkTelegramOperation)
export class LinkTelegramOperationHandler implements RequestHandler<
  LinkTelegramOperation,
  LinkTelegramResult
> {
  async handle(operation: LinkTelegramOperation): Promise<LinkTelegramResult> {
    const verified = await telegramService.execute(
      new VerifyInitDataRequest({ initData: operation.initData }),
    )
    if (!verified.success) {
      switch (verified.error) {
        case VerifyInitDataRequestErrorCode.NOT_CONFIGURED:
          return { success: false, error: LinkTelegramOperationErrorCode.NOT_CONFIGURED }
        case VerifyInitDataRequestErrorCode.INVALID:
          return { success: false, error: LinkTelegramOperationErrorCode.INIT_DATA_INVALID }
        case VerifyInitDataRequestErrorCode.EXPIRED:
          return { success: false, error: LinkTelegramOperationErrorCode.INIT_DATA_EXPIRED }
        default:
          return assertNever(verified.error)
      }
    }

    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: LinkTelegramOperationErrorCode.USER_NOT_FOUND }
        default:
          return assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: LinkTelegramOperationErrorCode.USER_NOT_FOUND }
    if (!user.isActive) return { success: false, error: LinkTelegramOperationErrorCode.USER_INACTIVE }

    const linked = await usersManager.execute(
      new LinkUserTelegramCommand({ userId: user.id, telegramId: verified.telegramUser.id }),
    )
    if (!linked.success) {
      switch (linked.error) {
        case LinkUserTelegramCommandErrorCode.USER_NOT_FOUND:
          return { success: false, error: LinkTelegramOperationErrorCode.USER_NOT_FOUND }
        case LinkUserTelegramCommandErrorCode.ALREADY_LINKED:
          return { success: false, error: LinkTelegramOperationErrorCode.ALREADY_LINKED }
        case LinkUserTelegramCommandErrorCode.TELEGRAM_ALREADY_TAKEN:
          return { success: false, error: LinkTelegramOperationErrorCode.TELEGRAM_TAKEN }
        default:
          return assertNever(linked.error)
      }
    }
    createLogger('authentication').info('Telegram linked', { userId: user.id })
    return { success: true }
  }
}
