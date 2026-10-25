import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { moodCheckins } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toMoodCheckinDTO } from '../../shared/diary.dto'
import { ListMoodCheckinsQuery } from './list-mood-checkins.query'
import { type ListMoodCheckinsQueryResult } from './list-mood-checkins.types'

@requestHandler(ListMoodCheckinsQuery)
export class ListMoodCheckinsQueryHandler implements RequestHandler<ListMoodCheckinsQuery, ListMoodCheckinsQueryResult> {
  async handle(c: ListMoodCheckinsQuery): Promise<ListMoodCheckinsQueryResult> {
    const rows = await getDb()
      .select()
      .from(moodCheckins)
      .where(and(eq(moodCheckins.userId, c.userId), gte(moodCheckins.localDate, c.from), lte(moodCheckins.localDate, c.to)))
      .orderBy(asc(moodCheckins.localDate))
    return { success: true, checkins: rows.map(toMoodCheckinDTO) }
  }
}
