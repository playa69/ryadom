import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { diaryManager, ListDiarySummariesQuery } from '../../../managers/diary-manager'
import { addDaysToDate, isValidDate, localMoment, weekStart } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'
import { userZone } from '../shared/user-zone'
import { checkinsBetween, DigestFailureCode, makeWeekSummary } from '../shared/digests'
import { CreateWeekSummaryOperation } from './create-week-summary.operation'
import { CreateWeekSummaryOperationErrorCode, type CreateWeekSummaryResult } from './create-week-summary.types'

@requestHandler(CreateWeekSummaryOperation)
export class CreateWeekSummaryOperationHandler implements RequestHandler<CreateWeekSummaryOperation, CreateWeekSummaryResult> {
  async handle(c: CreateWeekSummaryOperation): Promise<CreateWeekSummaryResult> {
    const now = c.now ?? new Date()
    const zone = await userZone(c.userId)
    if (!zone) return { success: false, error: CreateWeekSummaryOperationErrorCode.USER_NOT_FOUND }
    const currentWeek = weekStart(localMoment(now, zone).date)
    // Only the current week is built by hand; a finished week is closed by the scheduler.
    if (!isValidDate(c.weekStart) || c.weekStart !== currentWeek) {
      return { success: false, error: CreateWeekSummaryOperationErrorCode.DATE_OUT_OF_RANGE }
    }
    const days = await checkinsBetween(c.userId, currentWeek, addDaysToDate(currentWeek, 6))
    if (days.length < PROCESSES_CONFIG.DIARY.WEEK_SUMMARY_MIN_DAYS) {
      return { success: false, error: CreateWeekSummaryOperationErrorCode.NOT_ENOUGH_DAYS }
    }
    const existing = await diaryManager.execute(
      new ListDiarySummariesQuery({ userId: c.userId, kind: 'week', from: currentWeek, to: currentWeek, limit: 1 }),
    )
    const last = existing.summaries[0]
    if (last && now.getTime() - last.generatedAt.getTime() < PROCESSES_CONFIG.DIARY.SUMMARY_COOLDOWN_MS) {
      return { success: false, error: CreateWeekSummaryOperationErrorCode.TOO_SOON }
    }
    const made = await makeWeekSummary(c.userId, currentWeek, false, now)
    if (made.success) return { success: true, summary: made.summary }
    switch (made.error) {
      case DigestFailureCode.NOT_ENOUGH_DAYS:
        return { success: false, error: CreateWeekSummaryOperationErrorCode.NOT_ENOUGH_DAYS }
      case DigestFailureCode.SUMMARY_UNAVAILABLE:
        return { success: false, error: CreateWeekSummaryOperationErrorCode.SUMMARY_UNAVAILABLE }
      case DigestFailureCode.NOT_ENOUGH_WEEKS:
        throw new Error('A week summary does not depend on other weeks')
      default:
        return assertNever(made.error)
    }
  }
}
