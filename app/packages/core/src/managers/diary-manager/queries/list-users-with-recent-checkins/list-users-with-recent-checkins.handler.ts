import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, gte } from 'drizzle-orm'
import { moodCheckins, users } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { ListUsersWithRecentCheckinsQuery } from './list-users-with-recent-checkins.query'
import { type ListUsersWithRecentCheckinsQueryResult } from './list-users-with-recent-checkins.types'

@requestHandler(ListUsersWithRecentCheckinsQuery)
export class ListUsersWithRecentCheckinsQueryHandler implements RequestHandler<ListUsersWithRecentCheckinsQuery, ListUsersWithRecentCheckinsQueryResult> {
  async handle(c: ListUsersWithRecentCheckinsQuery): Promise<ListUsersWithRecentCheckinsQueryResult> {
    // Active people with a note on or after `since`; the zone comes with them because the week boundary depends on it.
    const rows = await getDb()
      .selectDistinct({ userId: moodCheckins.userId, timezone: users.timezone })
      .from(moodCheckins)
      .innerJoin(users, eq(users.id, moodCheckins.userId))
      .where(and(gte(moodCheckins.localDate, c.since), eq(users.isActive, true), eq(users.isDeleted, false)))
      .limit(c.limit)
    return { success: true, users: rows }
  }
}
