import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { selfCheckResults } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toSelfCheckResultDTO } from '../../shared/self-check.dto'
import { CountSelfCheckResultsQuery } from './count-self-check-results.query'
import { type CountSelfCheckResultsQueryResult } from './count-self-check-results.types'

@requestHandler(CountSelfCheckResultsQuery)
export class CountSelfCheckResultsQueryHandler implements RequestHandler<CountSelfCheckResultsQuery, CountSelfCheckResultsQueryResult> {
  async handle(c: CountSelfCheckResultsQuery): Promise<CountSelfCheckResultsQueryResult> {
    const rows = await getDb()
      .select({ id: selfCheckResults.id })
      .from(selfCheckResults)
      .where(
        and(
          eq(selfCheckResults.userId, c.userId),
          c.resultId ? eq(selfCheckResults.id, c.resultId) : undefined,
          c.testId ? eq(selfCheckResults.testId, c.testId) : undefined,
        ),
      )
    return { success: true, count: rows.length }
  }
}
