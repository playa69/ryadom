import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { MarkUserEmailConfirmedCommand } from './mark-user-email-confirmed.command'
import {
  MarkUserEmailConfirmedCommandErrorCode,
  type MarkUserEmailConfirmedCommandResult,
} from './mark-user-email-confirmed.types'

/**
 * Marks the address confirmed only while the account still holds the address that was proven. A
 * confirmation reads the account, checks the code and writes later; in between the address can have
 * been taken off the account, and marking an account that has none would lock the person out.
 */
@requestHandler(MarkUserEmailConfirmedCommand)
export class MarkUserEmailConfirmedCommandHandler implements RequestHandler<
  MarkUserEmailConfirmedCommand,
  MarkUserEmailConfirmedCommandResult
> {
  async handle(command: MarkUserEmailConfirmedCommand): Promise<MarkUserEmailConfirmedCommandResult> {
    if (!isUuid(command.userId)) {
      return { success: false, error: MarkUserEmailConfirmedCommandErrorCode.USER_NOT_FOUND }
    }
    const email = command.email.trim().toLowerCase()
    const [row] = await getDb()
      .update(users)
      .set({ isEmailConfirmed: true, updatedAt: new Date() })
      .where(and(eq(users.id, command.userId), eq(users.email, email)))
      .returning({ id: users.id })
    if (row) return { success: true }
    const [exists] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, command.userId))
    if (!exists) return { success: false, error: MarkUserEmailConfirmedCommandErrorCode.USER_NOT_FOUND }
    return { success: false, error: MarkUserEmailConfirmedCommandErrorCode.EMAIL_MISMATCH }
  }
}
