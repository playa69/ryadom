import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, lt } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { TouchUserActivityCommand } from './touch-user-activity.command'
import type { TouchUserActivityCommandResult } from './touch-user-activity.types'

/**
 * Records that the person was seen. The condition lives in the statement, so two requests at once
 * cannot both write, and a person who is seen all day costs one write an hour, not one per request.
 * `updated_at` is left alone: this is not a change to the account.
 */
@requestHandler(TouchUserActivityCommand)
export class TouchUserActivityCommandHandler implements RequestHandler<
  TouchUserActivityCommand,
  TouchUserActivityCommandResult
> {
  async handle(command: TouchUserActivityCommand): Promise<TouchUserActivityCommandResult> {
    if (isUuid(command.userId)) {
      await getDb()
        .update(users)
        .set({ lastActiveAt: command.at })
        .where(and(eq(users.id, command.userId), lt(users.lastActiveAt, command.unlessSeenAfter)))
    }
    return { success: true }
  }
}
