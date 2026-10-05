import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { count, eq, sql } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { GetSessionStatusQuery } from './get-session-status.query'
import type { GetSessionStatusQueryResult } from './get-session-status.types'

/**
 * Whether a session is still the person's, for what holds a stateless access token for longer than
 * the session lives (an open dialog). Ending a session retires every token of its chain, so one
 * retired for any reason but rotation is enough to call it ended. The expiry of the tokens is left
 * out on purpose: an access token never outlives the refresh token it was issued with.
 *
 * Judged by an ended token rather than by the lack of an active one, because rotation retires a
 * token a moment before it registers the next, and a check in that moment must not see an ended
 * session.
 */
@requestHandler(GetSessionStatusQuery)
export class GetSessionStatusQueryHandler implements RequestHandler<
  GetSessionStatusQuery,
  GetSessionStatusQueryResult
> {
  async handle(query: GetSessionStatusQuery): Promise<GetSessionStatusQueryResult> {
    if (!isUuid(query.sessionId)) return { success: true, active: false }
    const [row] = await getDb()
      .select({
        tokens: count(),
        ended: sql<boolean>`coalesce(bool_or(${refreshTokens.revokedReason} in ('signed_out', 'revoked')), false)`,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.sessionId, query.sessionId))
    return { success: true, active: (row?.tokens ?? 0) > 0 && !row?.ended }
  }
}
