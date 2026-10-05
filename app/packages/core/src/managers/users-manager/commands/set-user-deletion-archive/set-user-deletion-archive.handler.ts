import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq, sql } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { SetUserDeletionArchiveCommand } from './set-user-deletion-archive.command'
import {
  SetUserDeletionArchiveCommandErrorCode,
  type SetUserDeletionArchiveCommandResult,
} from './set-user-deletion-archive.types'
import { DELETION_ARCHIVE_KEY } from '../../shared/user.dto'

/** Stores the personal data archive in `users.properties.deletion`; other properties keys are untouched. */
@requestHandler(SetUserDeletionArchiveCommand)
export class SetUserDeletionArchiveCommandHandler implements RequestHandler<
  SetUserDeletionArchiveCommand,
  SetUserDeletionArchiveCommandResult
> {
  async handle(command: SetUserDeletionArchiveCommand): Promise<SetUserDeletionArchiveCommandResult> {
    if (!isUuid(command.userId)) {
      return { success: false, error: SetUserDeletionArchiveCommandErrorCode.USER_NOT_FOUND }
    }
    const archive = JSON.stringify(command.archive)
    const [row] = await getDb()
      .update(users)
      .set({
        properties: sql`coalesce(${users.properties}, '{}'::jsonb) || jsonb_build_object(${DELETION_ARCHIVE_KEY}::text, ${archive}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, command.userId))
      .returning({ id: users.id })
    if (!row) return { success: false, error: SetUserDeletionArchiveCommandErrorCode.USER_NOT_FOUND }
    return { success: true }
  }
}
