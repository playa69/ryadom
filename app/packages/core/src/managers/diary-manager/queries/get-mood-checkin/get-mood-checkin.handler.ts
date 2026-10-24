import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { moodCheckins } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toMoodCheckinDTO } from '../../shared/diary.dto'
import { GetMoodCheckinQuery } from './get-mood-checkin.query'
import { type GetMoodCheckinQueryResult } from './get-mood-checkin.types'

@requestHandler(GetMoodCheckinQuery)
export class GetMoodCheckinQueryHandler implements RequestHandler<GetMoodCheckinQuery, GetMoodCheckinQueryResult> {
  async handle(c: GetMoodCheckinQuery): Promise<GetMoodCheckinQueryResult> {
    const [row] = await getDb()
      .select()
      .from(moodCheckins)
      .where(and(eq(moodCheckins.userId, c.userId), eq(moodCheckins.localDate, c.localDate)))
      .limit(1)
    return { success: true, checkin: row ? toMoodCheckinDTO(row) : null }
  }
}
