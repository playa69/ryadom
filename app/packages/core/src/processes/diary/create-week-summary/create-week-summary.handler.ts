import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  ClaimDiarySummaryCommand,
  ClaimDiarySummaryCommandErrorCode,
  diaryManager,
  ListDiarySummariesQuery,
  ReleaseDiarySummaryCommand,
} from '../../../managers/diary-manager'
import { addDaysToDate, isValidDate, localMoment, weekStart } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'
import { userZone } from '../shared/user-zone'
import { checkinsBetween, DigestFailureCode, makeWeekSummary } from '../shared/digests'
import { CreateWeekSummaryOperation } from './create-week-summary.operation'
import { CreateWeekSummaryOperationErrorCode, type CreateWeekSummaryResult } from './create-week-summary.types'

/**
 * «Обновить итоги»: writes the text of the current week again now, whatever the six-hour gap of the background
 * pass. Not for the first text (the background pass writes it). Once in `MANUAL_COOLDOWN_MS`; the week is claimed
 * like any period, so a button press and the tick never ask the agent twice.
 */
@requestHandler(CreateWeekSummaryOperation)
export class CreateWeekSummaryOperationHandler implements RequestHandler<CreateWeekSummaryOperation, CreateWeekSummaryResult> {
  async handle(c: CreateWeekSummaryOperation): Promise<CreateWeekSummaryResult> {
    const config = PROCESSES_CONFIG.DIARY
    const now = c.now ?? new Date()
    const zone = await userZone(c.userId)
    if (!zone) return { success: false, error: CreateWeekSummaryOperationErrorCode.USER_NOT_FOUND }
    const currentWeek = weekStart(localMoment(now, zone).date)
    // Only the current week; a finished week is closed by the scheduler.
    if (!isValidDate(c.weekStart) || c.weekStart !== currentWeek) {
      return { success: false, error: CreateWeekSummaryOperationErrorCode.DATE_OUT_OF_RANGE }
    }
    const days = await checkinsBetween(c.userId, currentWeek, addDaysToDate(currentWeek, 6))
    if (days.length < config.WEEK_SUMMARY_MIN_DAYS) {
      return { success: false, error: CreateWeekSummaryOperationErrorCode.NOT_ENOUGH_DAYS }
    }
    const existing = (
      await diaryManager.execute(new ListDiarySummariesQuery({ userId: c.userId, kind: 'week', from: currentWeek, to: currentWeek, limit: 1 }))
    ).summaries[0]
    const lastManual = typeof existing?.stats?.manualAt === 'string' ? Date.parse(existing.stats.manualAt) : NaN
    if (!Number.isNaN(lastManual) && now.getTime() - lastManual < config.MANUAL_COOLDOWN_MS) {
      return { success: false, error: CreateWeekSummaryOperationErrorCode.TOO_SOON }
    }
    const claim = await diaryManager.execute(
      new ClaimDiarySummaryCommand({
        userId: c.userId,
        kind: 'week',
        periodStart: currentWeek,
        now,
        staleBefore: new Date(now.getTime() - config.PENDING_STALE_MS),
      }),
    )
    if (!claim.success) {
      switch (claim.error) {
        case ClaimDiarySummaryCommandErrorCode.ALREADY_CLAIMED:
          // The tick (or another press) is writing it right now.
          return { success: false, error: CreateWeekSummaryOperationErrorCode.TOO_SOON }
        default:
          return assertNever(claim.error)
      }
    }
    let made: Awaited<ReturnType<typeof makeWeekSummary>> | null = null
    try {
      made = await makeWeekSummary(c.userId, currentWeek, false, now, true)
    } finally {
      if (!made?.success) await diaryManager.execute(new ReleaseDiarySummaryCommand({ userId: c.userId, kind: 'week', periodStart: currentWeek }))
    }
    if (made.success) return { success: true, summary: made.summary }
    switch (made.error) {
      case DigestFailureCode.NOT_ENOUGH_DAYS:
        return { success: false, error: CreateWeekSummaryOperationErrorCode.NOT_ENOUGH_DAYS }
      case DigestFailureCode.SUMMARY_UNAVAILABLE:
        return { success: false, error: CreateWeekSummaryOperationErrorCode.SUMMARY_UNAVAILABLE }
      default:
        return assertNever(made.error)
    }
  }
}
