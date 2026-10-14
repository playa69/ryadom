import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull, or } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUniqueViolation, isUuid, withSavepoint } from '../../../../shared'
import { LinkUserTelegramCommand } from './link-user-telegram.command'
import {
  LinkUserTelegramCommandErrorCode,
  type LinkUserTelegramCommandResult,
} from './link-user-telegram.types'

/**
 * Gives an account its Telegram user. Linking the same user again is a success; an account that already
 * has another one keeps it (ALREADY_LINKED), so a person cannot be moved off their Telegram by whoever
 * holds a session of theirs.
 */
@requestHandler(LinkUserTelegramCommand)
export class LinkUserTelegramCommandHandler implements RequestHandler<
  LinkUserTelegramCommand,
  LinkUserTelegramCommandResult
> {
  async handle(command: LinkUserTelegramCommand): Promise<LinkUserTelegramCommandResult> {
    if (!isUuid(command.userId))
      return { success: false, error: LinkUserTelegramCommandErrorCode.USER_NOT_FOUND }
    try {
      // An UPDATE of a unique column cannot use ON CONFLICT: the savepoint keeps a violation from
      // aborting the surrounding transaction.
      const [row] = await withSavepoint((db) =>
        db
          .update(users)
          .set({ telegramId: command.telegramId, updatedAt: new Date() })
          .where(
            and(
              eq(users.id, command.userId),
              eq(users.isDeleted, false),
              or(isNull(users.telegramId), eq(users.telegramId, command.telegramId)),
            ),
          )
          .returning({ id: users.id }),
      )
      if (row) return { success: true }
    } catch (error) {
      if (isUniqueViolation(error, 'users_telegram_id_unique')) {
        return { success: false, error: LinkUserTelegramCommandErrorCode.TELEGRAM_ALREADY_TAKEN }
      }
      throw error
    }

    // Nothing was updated: tell a missing account from one that has another Telegram user.
    const [user] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
    if (!user) return { success: false, error: LinkUserTelegramCommandErrorCode.USER_NOT_FOUND }
    return { success: false, error: LinkUserTelegramCommandErrorCode.ALREADY_LINKED }
  }
}
