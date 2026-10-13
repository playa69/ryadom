import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, sql } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { TRAFFIC_TYPE_KEY } from '../../shared/user.dto'
import { SetUserTrafficTypeCommand } from './set-user-traffic-type.command'
import {
  SetUserTrafficTypeCommandErrorCode,
  type SetUserTrafficTypeCommandResult,
} from './set-user-traffic-type.types'

/**
 * Stores the mark in `users.properties.traffic_type`; `real` is the absence of the key. It sits beside, not inside,
 * `properties.analytics`: saving the person's analytics choice replaces that whole object. Other `properties` keys
 * (the deletion archive among them) are untouched.
 */
@requestHandler(SetUserTrafficTypeCommand)
export class SetUserTrafficTypeCommandHandler implements RequestHandler<
  SetUserTrafficTypeCommand,
  SetUserTrafficTypeCommandResult
> {
  async handle(command: SetUserTrafficTypeCommand): Promise<SetUserTrafficTypeCommandResult> {
    if (!isUuid(command.userId)) {
      return { success: false, error: SetUserTrafficTypeCommandErrorCode.USER_NOT_FOUND }
    }
    const properties =
      command.trafficType === 'real'
        ? sql`coalesce(${users.properties}, '{}'::jsonb) - ${TRAFFIC_TYPE_KEY}::text`
        : sql`coalesce(${users.properties}, '{}'::jsonb) || jsonb_build_object(${TRAFFIC_TYPE_KEY}::text, ${command.trafficType}::text)`
    const [row] = await getDb()
      .update(users)
      .set({ properties, updatedAt: new Date() })
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: SetUserTrafficTypeCommandErrorCode.USER_NOT_FOUND }
    return { success: true }
  }
}
