import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, gte, lt, lte } from 'drizzle-orm'
import { diarySummaries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toDiarySummaryDTO } from '../../shared/diary.dto'
import { ListDiarySummariesQuery } from './list-diary-summaries.query'
import { type ListDiarySummariesQueryResult } from './list-diary-summaries.types'

@requestHandler(ListDiarySummariesQuery)
export class ListDiarySummariesQueryHandler implements RequestHandler<ListDiarySummariesQuery, ListDiarySummariesQueryResult> {
  async handle(c: ListDiarySummariesQuery): Promise<ListDiarySummariesQueryResult> {
    // `before` is exclusive; `from`/`to` bound the period start; newest first.
    const conditions = [eq(diarySummaries.userId, c.userId), eq(diarySummaries.kind, c.kind)]
    if (c.before) conditions.push(lt(diarySummaries.periodStart, c.before))
    if (c.from) conditions.push(gte(diarySummaries.periodStart, c.from))
    if (c.to) conditions.push(lte(diarySummaries.periodStart, c.to))
    const rows = await getDb()
      .select()
      .from(diarySummaries)
      .where(and(...conditions))
      .orderBy(desc(diarySummaries.periodStart))
      .limit(c.limit ?? 100)
    return { success: true, summaries: rows.map(toDiarySummaryDTO) }
  }
}
