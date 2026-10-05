import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { SoftDeleteUserCommand } from './soft-delete-user.command'
import { SoftDeleteUserCommandErrorCode, type SoftDeleteUserCommandResult } from './soft-delete-user.types'

/**
 * Soft delete: the profile is anonymized and the account is marked deleted and inactive. The
 * email is replaced with a deterministic unique one, which frees the original address for a new
 * registration.
 */
@requestHandler(SoftDeleteUserCommand)
export class SoftDeleteUserCommandHandler implements RequestHandler<SoftDeleteUserCommand, SoftDeleteUserCommandResult> {
  async handle(command: SoftDeleteUserCommand): Promise<SoftDeleteUserCommandResult> {
    if (!isUuid(command.userId)) return { success: false, error: SoftDeleteUserCommandErrorCode.USER_NOT_FOUND }
    const db = getDb()
    const [user] = await db.select({ isDeleted: users.isDeleted }).from(users).where(eq(users.id, command.userId))
    if (!user) return { success: false, error: SoftDeleteUserCommandErrorCode.USER_NOT_FOUND }
    if (user.isDeleted) return { success: false, error: SoftDeleteUserCommandErrorCode.ALREADY_DELETED }
    const now = new Date()
    const [row] = await db
      .update(users)
      .set({
        email: `deleted+${command.userId}@anonymized.local`,
        name: null,
        isActive: false,
        isEmailConfirmed: false,
        isDeleted: true,
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: SoftDeleteUserCommandErrorCode.ALREADY_DELETED }
    return { success: true }
  }
}
