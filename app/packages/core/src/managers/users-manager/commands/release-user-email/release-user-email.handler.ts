import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { ReleaseUserEmailCommand } from './release-user-email.command'
import {
  ReleaseUserEmailCommandErrorCode,
  type ReleaseUserEmailCommandResult,
} from './release-user-email.types'

/**
 * Takes an unconfirmed address off an account; the account stays as it is, only without an address.
 * The address and the "not confirmed" state are part of the one UPDATE, so an address that was
 * confirmed, replaced or released a moment earlier is not touched and the caller learns it.
 */
@requestHandler(ReleaseUserEmailCommand)
export class ReleaseUserEmailCommandHandler implements RequestHandler<
  ReleaseUserEmailCommand,
  ReleaseUserEmailCommandResult
> {
  async handle(command: ReleaseUserEmailCommand): Promise<ReleaseUserEmailCommandResult> {
    if (!isUuid(command.userId))
      return { success: false, error: ReleaseUserEmailCommandErrorCode.ADDRESS_NOT_HELD }
    const email = command.email.trim().toLowerCase()
    const [row] = await getDb()
      .update(users)
      .set({ email: null, updatedAt: new Date() })
      .where(and(eq(users.id, command.userId), eq(users.email, email), eq(users.isEmailConfirmed, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: ReleaseUserEmailCommandErrorCode.ADDRESS_NOT_HELD }
    return { success: true }
  }
}
