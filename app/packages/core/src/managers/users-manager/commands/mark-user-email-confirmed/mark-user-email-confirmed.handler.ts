import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { MarkUserEmailConfirmedCommand } from './mark-user-email-confirmed.command'
import {
  MarkUserEmailConfirmedCommandErrorCode,
  type MarkUserEmailConfirmedCommandResult,
} from './mark-user-email-confirmed.types'

@requestHandler(MarkUserEmailConfirmedCommand)
export class MarkUserEmailConfirmedCommandHandler implements RequestHandler<
  MarkUserEmailConfirmedCommand,
  MarkUserEmailConfirmedCommandResult
> {
  async handle(command: MarkUserEmailConfirmedCommand): Promise<MarkUserEmailConfirmedCommandResult> {
    if (!isUuid(command.userId)) {
      return { success: false, error: MarkUserEmailConfirmedCommandErrorCode.USER_NOT_FOUND }
    }
    const [row] = await getDb()
      .update(users)
      .set({ isEmailConfirmed: true, updatedAt: new Date() })
      .where(eq(users.id, command.userId))
      .returning({ id: users.id })
    if (!row) return { success: false, error: MarkUserEmailConfirmedCommandErrorCode.USER_NOT_FOUND }
    return { success: true }
  }
}
