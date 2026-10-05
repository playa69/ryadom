import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, max, min, sql } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { ListUserSessionsQuery } from './list-user-sessions.query'
import type { ListUserSessionsQueryResult } from './list-user-sessions.types'

/**
 * Live sessions of a user, one row per chain of tokens. A session is live while none of its tokens
 * was signed out or revoked (a rotated one is just a link of the chain) and the newest has not
 * expired. What the client called itself is taken from the newest token, so a browser that updated
 * itself shows its current name.
 */
@requestHandler(ListUserSessionsQuery)
export class ListUserSessionsQueryHandler implements RequestHandler<
  ListUserSessionsQuery,
  ListUserSessionsQueryResult
> {
  async handle(query: ListUserSessionsQuery): Promise<ListUserSessionsQueryResult> {
    if (!isUuid(query.userId)) return { success: true, sessions: [] }
    const newest = <T>(column: typeof refreshTokens.clientId | typeof refreshTokens.userAgent) =>
      sql<T>`(array_agg(${column} order by ${refreshTokens.createdAt} desc))[1]`
    const lastUsedAt = max(refreshTokens.createdAt)
    const rows = await getDb()
      .select({
        sessionId: refreshTokens.sessionId,
        clientId: newest<string | null>(refreshTokens.clientId),
        userAgent: newest<string | null>(refreshTokens.userAgent),
        startedAt: min(refreshTokens.createdAt),
        lastUsedAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, query.userId))
      .groupBy(refreshTokens.sessionId)
      .having(
        and(
          sql`bool_and(${refreshTokens.revokedReason} is null or ${refreshTokens.revokedReason} = 'rotated')`,
          // A Date is not a column value here, so the driver is told in text what type it is.
          sql`max(${refreshTokens.expiresAt}) > ${query.now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(lastUsedAt), desc(refreshTokens.sessionId))
    return {
      success: true,
      sessions: rows.map((row) => ({
        sessionId: row.sessionId,
        clientId: row.clientId,
        userAgent: row.userAgent,
        // A group has at least one row, so these are never null.
        startedAt: row.startedAt!,
        lastUsedAt: row.lastUsedAt!,
      })),
    }
  }
}
