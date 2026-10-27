import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diaryManager, ListDiarySummariesQuery } from '../../../managers/diary-manager'
import { addDaysToDate, localMoment, weekStart } from '../../../shared'
import { userZone } from '../shared/user-zone'
import { checkinsBetween } from '../shared/digests'
import { markStreak } from '../shared/streak'
import { GetDiaryOperation } from './get-diary.operation'
import { GetDiaryOperationErrorCode, type GetDiaryResult } from './get-diary.types'

/** The mood chart shows this many days up to and including today. */
const RECENT_DAYS = 28

@requestHandler(GetDiaryOperation)
export class GetDiaryOperationHandler implements RequestHandler<GetDiaryOperation, GetDiaryResult> {
  async handle(c: GetDiaryOperation): Promise<GetDiaryResult> {
    const now = c.now ?? new Date()
    const zone = await userZone(c.userId)
    if (!zone) return { success: false, error: GetDiaryOperationErrorCode.USER_NOT_FOUND }
    const local = localMoment(now, zone)
    const start = weekStart(local.date)
    const lastWeek = addDaysToDate(start, -7)
    const [recentDays, weekDays, summaries, previous, streak] = await Promise.all([
      checkinsBetween(c.userId, addDaysToDate(local.date, -(RECENT_DAYS - 1)), local.date),
      checkinsBetween(c.userId, start, addDaysToDate(start, 6)),
      diaryManager.execute(new ListDiarySummariesQuery({ userId: c.userId, kind: 'week', from: start, to: start, limit: 1 })),
      diaryManager.execute(new ListDiarySummariesQuery({ userId: c.userId, kind: 'week', from: lastWeek, to: lastWeek, limit: 1 })),
      markStreak(c.userId, local.date),
    ])
    // Only a final summary (closed by the scheduler) is shown as «last week»; a button-made draft of that week is not.
    const previousWeek = previous.summaries[0]?.stats?.final === true ? previous.summaries[0] : null
    return {
      success: true,
      diary: {
        today: weekDays.find((d) => d.date === local.date) ?? null,
        recent: recentDays,
        streak,
        week: { start, markedDays: weekDays.length, summary: summaries.summaries[0] ?? null },
        previousWeek,
      },
    }
  }
}
