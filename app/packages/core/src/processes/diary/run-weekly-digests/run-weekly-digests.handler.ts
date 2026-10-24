import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diaryManager, ListDiarySummariesQuery, ListUsersWithRecentCheckinsQuery } from '../../../managers/diary-manager'
import { addDaysToDate, createLogger, localMoment, weekStart } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'
import { makeWeekSummary, makeYearStory } from '../shared/digests'

const log = createLogger('diary')
import { RunWeeklyDigestsOperation } from './run-weekly-digests.operation'
import { type RunWeeklyDigestsResult } from './run-weekly-digests.types'

@requestHandler(RunWeeklyDigestsOperation)
export class RunWeeklyDigestsOperationHandler implements RequestHandler<RunWeeklyDigestsOperation, RunWeeklyDigestsResult> {
  async handle(c: RunWeeklyDigestsOperation): Promise<RunWeeklyDigestsResult> {
    // For people whose local clock passed Monday 06:00 the finished week gets its final summary (3 or more
    // marked days), and the sixth final summary of the year brings the year story. A repeat makes nothing new.
    const config = PROCESSES_CONFIG.DIARY
    const now = c.now ?? new Date()
    const limit = c.limit ?? config.WEEKLY_PASS_LIMIT
    // A wide net: the week boundary depends on the zone, so the people are checked one by one below.
    const since = addDaysToDate(now.toISOString().slice(0, 10), -config.WEEKLY_PEOPLE_WINDOW_DAYS)
    const { users: people } = await diaryManager.execute(
      new ListUsersWithRecentCheckinsQuery({ since, limit: config.WEEKLY_PEOPLE_MAX }),
    )
    let weekly = 0
    let yearly = 0
    for (const { userId, timezone } of people) {
      if (weekly + yearly >= limit) break
      const local = localMoment(now, timezone)
      // Monday after 06:00 and later: a missed Monday is made up on the next passes of the week.
      if (local.isoWeekday === 1 && local.minutes < config.WEEKLY_CLOSE_MINUTES) continue
      const lastWeek = addDaysToDate(weekStart(local.date), -7)
      const existing = await diaryManager.execute(
        new ListDiarySummariesQuery({ userId, kind: 'week', from: lastWeek, to: lastWeek, limit: 1 }),
      )
      if (existing.summaries[0]?.stats?.final === true) continue
      try {
        const made = await makeWeekSummary(userId, lastWeek, true, now)
        if (!made.success) continue
        weekly += 1
        const story = await makeYearStory(userId, Number(lastWeek.slice(0, 4)), now)
        if (story.success) yearly += 1
      } catch (error) {
        log.error('Не удалось собрать итоги недели', error)
      }
    }
    return { success: true, weekly, yearly }
  }
}
