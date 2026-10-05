import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { SetUserActiveCommand } from './set-user-active.command'
import { SetUserActiveCommandErrorCode, type SetUserActiveCommandResult } from './set-user-active.types'

/** Blocking (`isActive = false`) and unblocking. A deleted account is left untouched. */
@requestHandler(SetUserActiveCommand)
export class SetUserActiveCommandHandler implements RequestHandler<SetUserActiveCommand, SetUserActiveCommandResult> {
  async handle(command: SetUserActiveCommand): Promise<SetUserActiveCommandResult> {
    if (!isUuid(command.userId)) return { success: false, error: SetUserActiveCommandErrorCode.USER_NOT_FOUND }
    const db = getDb()
    const [user] = await db.select({ isDeleted: users.isDeleted }).from(users).where(eq(users.id, command.userId))
    if (!user) return { success: false, error: SetUserActiveCommandErrorCode.USER_NOT_FOUND }
    if (user.isDeleted) return { success: false, error: SetUserActiveCommandErrorCode.USER_DELETED }
    // The is_deleted check lives in the UPDATE itself, so a deletion that happens between the read
    // and the write cannot unblock the account.
    const [row] = await db
      .update(users)
      .set({ isActive: command.isActive, updatedAt: new Date() })
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: SetUserActiveCommandErrorCode.USER_DELETED }
    return { success: true }
  }
}
