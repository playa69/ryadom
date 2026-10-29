import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { selfCheckResults, userConsents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toSelfCheckResultDTO } from '../../shared/self-check.dto'
import { ListSelfCheckResultsQuery } from './list-self-check-results.query'
import { type ListSelfCheckResultsQueryResult } from './list-self-check-results.types'

@requestHandler(ListSelfCheckResultsQuery)
export class ListSelfCheckResultsQueryHandler implements RequestHandler<
  ListSelfCheckResultsQuery,
  ListSelfCheckResultsQueryResult
> {
  async handle(c: ListSelfCheckResultsQuery): Promise<ListSelfCheckResultsQueryResult> {
    const rows = await getDb()
      .select()
      .from(selfCheckResults)
      .where(
        and(
          eq(selfCheckResults.userId, c.userId),
          c.testId ? eq(selfCheckResults.testId, c.testId) : undefined,
          c.before ? lt(selfCheckResults.takenAt, c.before) : undefined,
        ),
      )
      .orderBy(desc(selfCheckResults.takenAt))
      .limit(c.limit)
    return { success: true, results: rows.map(toSelfCheckResultDTO) }
  }
}
