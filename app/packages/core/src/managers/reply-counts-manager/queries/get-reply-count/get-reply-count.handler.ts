import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { userReplyCounts } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { GetReplyCountQuery } from './get-reply-count.query'
import type { GetReplyCountQueryResult } from './get-reply-count.types'

@requestHandler(GetReplyCountQuery)
export class GetReplyCountQueryHandler implements RequestHandler<
  GetReplyCountQuery,
  GetReplyCountQueryResult
> {
  async handle(query: GetReplyCountQuery): Promise<GetReplyCountQueryResult> {
    const [row] = await getDb()
      .select({
        day: userReplyCounts.day,
        replies: userReplyCounts.replies,
        firstReplyAt: userReplyCounts.firstReplyAt,
      })
      .from(userReplyCounts)
      .where(eq(userReplyCounts.userId, query.userId))
    return { success: true, count: row ?? null }
  }
}
