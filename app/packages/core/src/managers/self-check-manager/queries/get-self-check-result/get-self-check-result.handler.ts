import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { selfCheckResults } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toSelfCheckResultDTO } from '../../shared/self-check.dto'
import { GetSelfCheckResultQuery } from './get-self-check-result.query'
import { type GetSelfCheckResultQueryResult } from './get-self-check-result.types'

@requestHandler(GetSelfCheckResultQuery)
export class GetSelfCheckResultQueryHandler implements RequestHandler<GetSelfCheckResultQuery, GetSelfCheckResultQueryResult> {
  async handle(c: GetSelfCheckResultQuery): Promise<GetSelfCheckResultQueryResult> {
    const [row] = await getDb()
      .select()
      .from(selfCheckResults)
      .where(and(eq(selfCheckResults.userId, c.userId), eq(selfCheckResults.id, c.resultId)))
      .limit(1)
    return { success: true, result: row ? toSelfCheckResultDTO(row) : null }
  }
}
