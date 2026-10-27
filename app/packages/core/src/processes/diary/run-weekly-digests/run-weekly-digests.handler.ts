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
import { checkinsBetween, inputsVersion, isStale, makeWeekSummary, weekRecaps, writtenAt, type WeekRecap } from '../shared/digests'
import { AgentUnavailableError } from '../../../shared'

const log = createLogger('diary')
import { RunWeeklyDigestsOperation } from './run-weekly-digests.operation'
import { type RunWeeklyDigestsResult } from './run-weekly-digests.types'

@requestHandler(RunWeeklyDigestsOperation)
export class RunWeeklyDigestsOperationHandler implements RequestHandler<RunWeeklyDigestsOperation, RunWeeklyDigestsResult> {
  async handle(c: RunWeeklyDigestsOperation): Promise<RunWeeklyDigestsResult> {
    // For people whose local clock passed Monday 06:00 the finished week gets its final summary (3 or more
    // marked days); the week in progress gets its text once 3 days are marked and a new one after its marks
    // change. A repeat makes nothing new.
    const config = PROCESSES_CONFIG.DIARY
    const now = c.now ?? new Date()
    const limit = c.limit ?? config.WEEKLY_PASS_LIMIT
    // A wide net: the week boundary depends on the zone, so the people are checked one by one below.
    const since = addDaysToDate(now.toISOString().slice(0, 10), -config.WEEKLY_PEOPLE_WINDOW_DAYS)
    const { users: people } = await diaryManager.execute(
      new ListUsersWithRecentCheckinsQuery({ since, limit: config.WEEKLY_PEOPLE_MAX }),
    )
    const weeklyUserIds: string[] = []
    for (const { userId, timezone } of people) {
      if (weeklyUserIds.length >= limit) break
      const local = localMoment(now, timezone)
      const currentWeek = weekStart(local.date)
      // Monday after 06:00 and later: a missed Monday is made up on the next passes of the week.
      const closing = !(local.isoWeekday === 1 && local.minutes < config.WEEKLY_CLOSE_MINUTES)
      if (closing && (await this.write(userId, addDaysToDate(currentWeek, -7), true, now))) weeklyUserIds.push(userId)
      // The week in progress: written once 3 days are marked, rewritten after the marks change.
      if (weeklyUserIds.length < limit && (await this.write(userId, currentWeek, false, now))) weeklyUserIds.push(userId)
    }
    await this.rebuildAfterDeletions(now, limit, weeklyUserIds)
    return { success: true, weekly: weeklyUserIds.length, weeklyUserIds }
  }

  /**
   * Writes the text of the week `periodStart` if it has none, was not closed yet (`final`) or a mark changed after it
   * was written, and the last change is at least `AUTO_QUIET_MS` old. The period is claimed first (D9): of several replicas
   * one asks the agent; the old text stays in view until the new one replaces it. True when a text was written.
   */
  private async write(userId: string, periodStart: string, final: boolean, now: Date): Promise<boolean> {
    const config = PROCESSES_CONFIG.DIARY
    const days = await checkinsBetween(userId, periodStart, addDaysToDate(periodStart, 6))
    // Fewer than 3 marked days: nothing to write, and nothing worth claiming every minute.
    if (days.length < config.WEEK_SUMMARY_MIN_DAYS) return false
    // The recaps of the week's conversations are read with the marks: a new one makes the text stale like a changed mark. A down
    // agent ends the attempt (a text written without recaps it could not read would never learn of them later).
    let recaps: WeekRecap[]
    try {
      recaps = await weekRecaps(userId, periodStart)
    } catch (error) {
      if (error instanceof AgentUnavailableError) return false
      throw error
    }
    if (now.getTime() - inputsVersion(days, recaps).getTime() < config.AUTO_QUIET_MS) return false
    const existing = (
      await diaryManager.execute(new ListDiarySummariesQuery({ userId, kind: 'week', from: periodStart, to: periodStart, limit: 1 }))
    ).summaries[0]
    if (existing && !isStale(existing, days, recaps) && (!final || existing.stats?.final === true)) return false
    // A text of the week in progress is rewritten after a change at most once in AUTO_MIN_GAP_MS (the button «Обновить итоги»
    // does not wait); the first text and the Monday close do not wait either.
    if (existing && !final && now.getTime() - writtenAt(existing).getTime() < config.AUTO_MIN_GAP_MS) return false
    const staleBefore = new Date(now.getTime() - config.PENDING_STALE_MS)
    if (!(await this.claim(userId, 'week', periodStart, now, staleBefore, final))) return false
    let written = false
    try {
      written = (await makeWeekSummary(userId, periodStart, final, now, false, recaps)).success
    } catch (error) {
      log.error('Не удалось собрать итоги недели', error)
    } finally {
      // The agent did not answer (or something broke): the claim goes back, the next pass tries again.
      if (!written) await diaryManager.execute(new ReleaseDiarySummaryCommand({ userId, kind: 'week', periodStart }))
    }
    return written
  }

  /**
   * Texts removed with a conversation (`RecomputeSummariesAfterDialogDeletedOperation`) leave markers: a finished week of
   * the last weeks is written again from what is left (if it still has 3 marked days). A marker is claimed like any
   * period, so with several replicas the agent is asked once.
   */
  private async rebuildAfterDeletions(now: Date, limit: number, weeklyUserIds: string[]): Promise<void> {
    const config = PROCESSES_CONFIG.DIARY
    const today = now.toISOString().slice(0, 10)
    const weeksSince = addDaysToDate(today, -7 * (config.RECOMPUTE_WEEKS + 1))
    const { markers } = await diaryManager.execute(new ListRecomputeMarkersQuery({ weeksSince, limit: config.RECOMPUTE_PASS_MAX }))
    const staleBefore = new Date(now.getTime() - config.PENDING_STALE_MS)
    for (const marker of markers) {
      if (weeklyUserIds.length >= limit) break
      const days = await checkinsBetween(marker.userId, marker.periodStart, addDaysToDate(marker.periodStart, 6))
      if (days.length < config.WEEK_SUMMARY_MIN_DAYS) {
        // Nothing to write any more: the week stays without a text.
        await diaryManager.execute(new DeleteDiarySummaryCommand({ userId: marker.userId, kind: 'week', periodStart: marker.periodStart, status: 'pending' }))
        continue
      }
      if (!(await this.claim(marker.userId, 'week', marker.periodStart, now, staleBefore))) continue
      let made = false
      try {
        made = (await makeWeekSummary(marker.userId, marker.periodStart, true, now)).success
        if (made) weeklyUserIds.push(marker.userId)
      } catch (error) {
        log.error('Не удалось пересобрать итоги недели после удаления разговора', error)
      } finally {
        if (!made) await diaryManager.execute(new ReleaseDiarySummaryCommand({ userId: marker.userId, kind: 'week', periodStart: marker.periodStart }))
      }
    }
  }

  private async claim(
    userId: string,
    kind: 'week',
    periodStart: string,
    now: Date,
    staleBefore: Date,
    allowFinal = false,
  ): Promise<boolean> {
    const claim = await diaryManager.execute(new ClaimDiarySummaryCommand({ userId, kind, periodStart, now, staleBefore, allowFinal }))
    if (claim.success) return true
    switch (claim.error) {
      case ClaimDiarySummaryCommandErrorCode.ALREADY_CLAIMED:
        return false
      default:
        return assertNever(claim.error)
    }
  }
}
