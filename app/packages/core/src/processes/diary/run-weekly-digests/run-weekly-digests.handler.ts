import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  ClaimDiarySummaryCommand,
  ClaimDiarySummaryCommandErrorCode,
  DeleteDiarySummaryCommand,
  diaryManager,
  ListDiarySummariesQuery,
  ListRecomputeMarkersQuery,
  ListUsersWithRecentCheckinsQuery,
  ReleaseDiarySummaryCommand,
} from '../../../managers/diary-manager'
import { addDaysToDate, createLogger, localMoment, weekStart } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'
import { checkinsBetween, DigestFailureCode, makeWeekSummary, makeYearStory } from '../shared/digests'

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
    const weeklyUserIds: string[] = []
    const yearlyUserIds: string[] = []
    for (const { userId, timezone } of people) {
      if (weeklyUserIds.length + yearlyUserIds.length >= limit) break
      const local = localMoment(now, timezone)
      // Monday after 06:00 and later: a missed Monday is made up on the next passes of the week.
      if (local.isoWeekday === 1 && local.minutes < config.WEEKLY_CLOSE_MINUTES) continue
      const lastWeek = addDaysToDate(weekStart(local.date), -7)
      const existing = await diaryManager.execute(
        new ListDiarySummariesQuery({ userId, kind: 'week', from: lastWeek, to: lastWeek, limit: 1 }),
      )
      if (existing.summaries[0]?.stats?.final === true) continue
      // Fewer than 3 marked days: nothing to close, and nothing worth claiming every minute.
      const days = await checkinsBetween(userId, lastWeek, addDaysToDate(lastWeek, 6))
      if (days.length < config.WEEK_SUMMARY_MIN_DAYS) continue
      // The period is taken by a `pending` row first; the agent is called only by the replica that got it (D9).
      const claim = await diaryManager.execute(
        new ClaimDiarySummaryCommand({
          userId,
          kind: 'week',
          periodStart: lastWeek,
          now,
          staleBefore: new Date(now.getTime() - config.PENDING_STALE_MS),
        }),
      )
      if (!claim.success) {
        switch (claim.error) {
          case ClaimDiarySummaryCommandErrorCode.ALREADY_CLAIMED:
            continue
          default:
            assertNever(claim.error)
        }
      }
      let closed = false
      try {
        closed = (await makeWeekSummary(userId, lastWeek, true, now)).success
        if (closed) {
          weeklyUserIds.push(userId)
          const story = await makeYearStory(userId, Number(lastWeek.slice(0, 4)), now)
          if (story.success) yearlyUserIds.push(userId)
        }
      } catch (error) {
        log.error('Не удалось собрать итоги недели', error)
      } finally {
        // The agent did not answer (or something broke): the claim goes back, the next pass tries again.
        if (!closed) await diaryManager.execute(new ReleaseDiarySummaryCommand({ userId, kind: 'week', periodStart: lastWeek }))
      }
    }
    await this.rebuildAfterDeletions(now, limit, weeklyUserIds, yearlyUserIds)
    return { success: true, weekly: weeklyUserIds.length, yearly: yearlyUserIds.length, weeklyUserIds, yearlyUserIds }
  }

  /**
   * Texts removed with a conversation (`RecomputeSummariesAfterDialogDeletedOperation`) leave markers: a finished week of
   * the last weeks is written again from what is left (if it still has 3 marked days), then the year story of a person
   * whose weeks are all done. A marker is claimed like any period, so with several replicas the agent is asked once.
   */
  private async rebuildAfterDeletions(now: Date, limit: number, weeklyUserIds: string[], yearlyUserIds: string[]): Promise<void> {
    const config = PROCESSES_CONFIG.DIARY
    const today = now.toISOString().slice(0, 10)
    const weeksSince = addDaysToDate(today, -7 * (config.RECOMPUTE_WEEKS + 1))
    const { markers } = await diaryManager.execute(new ListRecomputeMarkersQuery({ weeksSince, limit: config.RECOMPUTE_PASS_MAX }))
    const staleBefore = new Date(now.getTime() - config.PENDING_STALE_MS)
    // Weeks a person still waits for in a year: the year story waits for them (an agent that is down, a marker not yet claimed).
    const waiting = new Set<string>()
    for (const marker of markers.filter((m) => m.kind === 'week')) {
      const key = `${marker.userId}:${marker.periodStart.slice(0, 4)}`
      if (weeklyUserIds.length + yearlyUserIds.length >= limit) {
        waiting.add(key)
        continue
      }
      const days = await checkinsBetween(marker.userId, marker.periodStart, addDaysToDate(marker.periodStart, 6))
      if (days.length < config.WEEK_SUMMARY_MIN_DAYS) {
        // Nothing to write any more: the week stays without a text.
        await diaryManager.execute(new DeleteDiarySummaryCommand({ userId: marker.userId, kind: 'week', periodStart: marker.periodStart, status: 'pending' }))
        continue
      }
      const claimed = await this.claim(marker.userId, 'week', marker.periodStart, now, staleBefore)
      if (!claimed) {
        waiting.add(key)
        continue
      }
      let made = false
      try {
        made = (await makeWeekSummary(marker.userId, marker.periodStart, true, now)).success
        if (made) weeklyUserIds.push(marker.userId)
      } catch (error) {
        log.error('Не удалось пересобрать итоги недели после удаления разговора', error)
      } finally {
        if (!made) {
          waiting.add(key)
          await diaryManager.execute(new ReleaseDiarySummaryCommand({ userId: marker.userId, kind: 'week', periodStart: marker.periodStart }))
        }
      }
    }
    for (const marker of markers.filter((m) => m.kind === 'year')) {
      const year = Number(marker.periodStart.slice(0, 4))
      if (waiting.has(`${marker.userId}:${year}`) || weeklyUserIds.length + yearlyUserIds.length >= limit) continue
      if (!(await this.claim(marker.userId, 'year', marker.periodStart, now, staleBefore))) continue
      let made = false
      try {
        const story = await makeYearStory(marker.userId, year, now, true)
        made = story.success
        if (story.success) yearlyUserIds.push(marker.userId)
        // Fewer than six final weeks are left: there is no story to write, the marker goes.
        else if (story.error === DigestFailureCode.NOT_ENOUGH_WEEKS) {
          await diaryManager.execute(new DeleteDiarySummaryCommand({ userId: marker.userId, kind: 'year', periodStart: marker.periodStart, status: 'pending' }))
          made = true
        }
      } catch (error) {
        log.error('Не удалось пересобрать историю года после удаления разговора', error)
      } finally {
        if (!made) await diaryManager.execute(new ReleaseDiarySummaryCommand({ userId: marker.userId, kind: 'year', periodStart: marker.periodStart }))
      }
    }
  }

  private async claim(userId: string, kind: 'week' | 'year', periodStart: string, now: Date, staleBefore: Date): Promise<boolean> {
    const claim = await diaryManager.execute(new ClaimDiarySummaryCommand({ userId, kind, periodStart, now, staleBefore }))
    if (claim.success) return true
    switch (claim.error) {
      case ClaimDiarySummaryCommandErrorCode.ALREADY_CLAIMED:
        return false
      default:
        return assertNever(claim.error)
    }
  }
}
