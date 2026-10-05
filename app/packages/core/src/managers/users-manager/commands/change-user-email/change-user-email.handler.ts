import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { isUniqueViolation, isUuid, withSavepoint } from '../../../../shared'
import { ChangeUserEmailCommand } from './change-user-email.command'
import { ChangeUserEmailCommandErrorCode, type ChangeUserEmailCommandResult } from './change-user-email.types'

/** Changes the email right away; the email confirmation flag is not reset. */
@requestHandler(ChangeUserEmailCommand)
export class ChangeUserEmailCommandHandler implements RequestHandler<
  ChangeUserEmailCommand,
  ChangeUserEmailCommandResult
> {
  async handle(command: ChangeUserEmailCommand): Promise<ChangeUserEmailCommandResult> {
    if (!isUuid(command.userId)) {
      return { success: false, error: ChangeUserEmailCommandErrorCode.USER_NOT_FOUND }
    }
    const email = command.email.trim().toLowerCase()
    try {
      // An UPDATE of a unique column cannot use ON CONFLICT, so it is isolated in a savepoint to
      // keep a uniqueness violation from aborting the surrounding transaction.
      const [row] = await withSavepoint((db) =>
        db
          .update(users)
          .set({ email, updatedAt: new Date() })
          .where(eq(users.id, command.userId))
          .returning({ id: users.id }),
      )
      if (!row) return { success: false, error: ChangeUserEmailCommandErrorCode.USER_NOT_FOUND }
      return { success: true }
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_unique')) {
        return { success: false, error: ChangeUserEmailCommandErrorCode.EMAIL_ALREADY_TAKEN }
      }
      throw error
    }
  }
}
