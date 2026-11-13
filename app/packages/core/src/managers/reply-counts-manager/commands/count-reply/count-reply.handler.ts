import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { sql } from 'drizzle-orm'
import { userReplyCounts } from '@ryadom/db/schema'
import { isForeignKeyViolation, withSavepoint } from '../../../../shared'
import { CountReplyCommand } from './count-reply.command'
import { CountReplyCommandErrorCode, type CountReplyCommandResult } from './count-reply.types'

/** The goals count calendar days in Moscow for everybody, whatever zone the person lives in. */
const MOSCOW_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The row is inserted with the account's first reply (`first_reply_at` is set then and never again), and later bumped,
 * or restarted at 1 when its day is not the reply's.
 */
@requestHandler(CountReplyCommand)
export class CountReplyCommandHandler implements RequestHandler<CountReplyCommand, CountReplyCommandResult> {
  async handle(command: CountReplyCommand): Promise<CountReplyCommandResult> {
    const day = MOSCOW_DAY.format(command.at)
    try {
      // A savepoint: a foreign key failure would otherwise break the transaction the caller may be in.
      await withSavepoint((db) =>
        db
          .insert(userReplyCounts)
          .values({
            userId: command.userId,
            day,
            replies: 1,
            firstReplyAt: command.at,
            updatedAt: command.at,
          })
          .onConflictDoUpdate({
            target: userReplyCounts.userId,
            set: {
              replies: sql`case when ${userReplyCounts.day} = excluded.day then ${userReplyCounts.replies} + 1 else 1 end`,
              day: sql`excluded.day`,
              updatedAt: sql`excluded.updated_at`,
            },
          }),
      )
      return { success: true }
    } catch (error) {
      if (isForeignKeyViolation(error))
        return { success: false, error: CountReplyCommandErrorCode.USER_NOT_FOUND }
      throw error
    }
  }
}
