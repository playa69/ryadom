import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, asc, eq, exists, isNull, lt } from 'drizzle-orm'
import { userDevices, users } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toUserDTO } from '../../shared/user.dto'
import { ListInactiveAnonymousUsersQuery } from './list-inactive-anonymous-users.query'
import type { ListInactiveAnonymousUsersQueryResult } from './list-inactive-anonymous-users.types'

/**
 * Anonymous accounts nobody has opened for a while. "Anonymous" is an account that can only be
 * reached through a device key: it has one, and its address is not confirmed (there is none, or a
 * code was never entered), and no Telegram is linked. A confirmed address or a Telegram account is a
 * way back in from anywhere, so such an account is the person's to keep. A blocked account stays too: that is an admin's decision, and erasing it
 * would hand the person a clean slate.
 */
@requestHandler(ListInactiveAnonymousUsersQuery)
export class ListInactiveAnonymousUsersQueryHandler implements RequestHandler<
  ListInactiveAnonymousUsersQuery,
  ListInactiveAnonymousUsersQueryResult
> {
  async handle(query: ListInactiveAnonymousUsersQuery): Promise<ListInactiveAnonymousUsersQueryResult> {
    const db = getDb()
    const rows = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.isDeleted, false),
          eq(users.isActive, true),
          eq(users.isEmailConfirmed, false),
          isNull(users.telegramId),
          lt(users.lastActiveAt, query.inactiveSince),
          exists(db.select({ id: userDevices.id }).from(userDevices).where(eq(userDevices.userId, users.id))),
        ),
      )
      .orderBy(asc(users.lastActiveAt), asc(users.id))
      .limit(query.limit)
    return { success: true, users: rows.map(toUserDTO) }
  }
}
