import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { localMoment } from '../../../shared'
import { userZone } from '../shared/user-zone'
import { checkinsBetween, finalWeekSummaries, yearStoryOf } from '../shared/digests'
import { GetYearOperation } from './get-year.operation'
import { GetYearOperationErrorCode, type GetYearResult } from './get-year.types'

@requestHandler(GetYearOperation)
export class GetYearOperationHandler implements RequestHandler<GetYearOperation, GetYearResult> {
  async handle(c: GetYearOperation): Promise<GetYearResult> {
    const zone = await userZone(c.userId)
    if (!zone) return { success: false, error: GetYearOperationErrorCode.USER_NOT_FOUND }
    const year = c.year ?? Number(localMoment(c.now ?? new Date(), zone).date.slice(0, 4))
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return { success: false, error: GetYearOperationErrorCode.YEAR_OUT_OF_RANGE }
    }
    const days = await checkinsBetween(c.userId, `${year}-01-01`, `${year}-12-31`)
    const [weekly, story] = await Promise.all([finalWeekSummaries(c.userId, year), yearStoryOf(c.userId, year)])
    const counts = new Map<number, number>()
    for (const d of days) counts.set(d.mood, (counts.get(d.mood) ?? 0) + 1)
    // The most frequent level; a tie goes to the higher one.
    let mostFrequent: number | null = null
    let best = 0
    for (const level of [1, 2, 3, 4, 5]) {
      const count = counts.get(level) ?? 0
      if (count > 0 && count >= best) {
        mostFrequent = level
        best = count
      }
    }
    return {
      success: true,
      year: {
        year,
        days,
        markedDays: days.length,
        mostFrequent,
        weeklyCount: weekly.length,
        story: story
          ? { text: story.text, generatedAt: story.generatedAt, weeklyCount: Number(story.stats?.weeklyCount ?? 0) }
          : null,
      },
    }
  }
}
