import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, sql } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { ANALYTICS_PREFS_KEY } from '../../shared/user.dto'
import { SetUserAnalyticsOptOutCommand } from './set-user-analytics-opt-out.command'
import {
  SetUserAnalyticsOptOutCommandErrorCode,
  type SetUserAnalyticsOptOutCommandResult,
} from './set-user-analytics-opt-out.types'

/**
 * Stores the choice in `users.properties.analytics.optOut`; other `properties` keys (the deletion
 * archive among them) are untouched. A column of its own would be a migration for one boolean.
 */
@requestHandler(SetUserAnalyticsOptOutCommand)
export class SetUserAnalyticsOptOutCommandHandler implements RequestHandler<
  SetUserAnalyticsOptOutCommand,
  SetUserAnalyticsOptOutCommandResult
> {
  async handle(command: SetUserAnalyticsOptOutCommand): Promise<SetUserAnalyticsOptOutCommandResult> {
    if (!isUuid(command.userId)) {
      return { success: false, error: SetUserAnalyticsOptOutCommandErrorCode.USER_NOT_FOUND }
    }
    const prefs = JSON.stringify({ optOut: command.optOut })
    const [row] = await getDb()
      .update(users)
      .set({
        properties: sql`coalesce(${users.properties}, '{}'::jsonb) || jsonb_build_object(${ANALYTICS_PREFS_KEY}::text, ${prefs}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: SetUserAnalyticsOptOutCommandErrorCode.USER_NOT_FOUND }
    return { success: true }
  }
}
