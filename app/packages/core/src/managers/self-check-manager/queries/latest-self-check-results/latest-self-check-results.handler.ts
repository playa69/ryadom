import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { selfCheckResults, userConsents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toSelfCheckResultDTO } from '../../shared/self-check.dto'
import { LatestSelfCheckResultsQuery } from './latest-self-check-results.query'
import { type LatestSelfCheckResultsQueryResult } from './latest-self-check-results.types'

@requestHandler(LatestSelfCheckResultsQuery)
export class LatestSelfCheckResultsQueryHandler implements RequestHandler<
  LatestSelfCheckResultsQuery,
  LatestSelfCheckResultsQueryResult
> {
  async handle(c: LatestSelfCheckResultsQuery): Promise<LatestSelfCheckResultsQueryResult> {
    // The newest result of every test: one row per test_id.
    const rows = await getDb()
      .selectDistinctOn([selfCheckResults.testId])
      .from(selfCheckResults)
      .where(eq(selfCheckResults.userId, c.userId))
      .orderBy(selfCheckResults.testId, desc(selfCheckResults.takenAt))
    return { success: true, results: rows.map(toSelfCheckResultDTO) }
  }
}
