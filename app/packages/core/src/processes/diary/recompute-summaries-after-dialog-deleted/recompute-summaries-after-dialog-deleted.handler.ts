import { requestHandler, type RequestHandler } from 'mediatr-ts'
import {
  DeleteDiarySummaryCommand,
  diaryManager,
  ListDiarySummariesQuery,
  MarkDiarySummaryForRecomputeCommand,
} from '../../../managers/diary-manager'
import { addDaysToDate, localMoment, weekStart } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'
import { userZone } from '../shared/user-zone'
import { RecomputeSummariesAfterDialogDeletedOperation } from './recompute-summaries-after-dialog-deleted.operation'
import {
  RecomputeSummariesAfterDialogDeletedOperationErrorCode,
  type RecomputeSummariesAfterDialogDeletedResult,
} from './recompute-summaries-after-dialog-deleted.types'

@requestHandler(RecomputeSummariesAfterDialogDeletedOperation)
export class RecomputeSummariesAfterDialogDeletedOperationHandler
  implements RequestHandler<RecomputeSummariesAfterDialogDeletedOperation, RecomputeSummariesAfterDialogDeletedResult>
{
  async handle(c: RecomputeSummariesAfterDialogDeletedOperation): Promise<RecomputeSummariesAfterDialogDeletedResult> {
    const zone = await userZone(c.userId)
    if (!zone) return { success: false, error: RecomputeSummariesAfterDialogDeletedOperationErrorCode.USER_NOT_FOUND }
    const now = c.now ?? new Date()
    const week = weekStart(localMoment(c.dialogAt, zone).date)
    const currentWeek = weekStart(localMoment(now, zone).date)
    const year = week.slice(0, 4)

    // What is on screen now: the week text goes first and at once, with no stale retelling left to read.
    const { summaries } = await diaryManager.execute(
      new ListDiarySummariesQuery({ userId: c.userId, kind: 'week', from: week, to: week, limit: 1 }),
    )
    const existing = summaries[0] ?? null
    if (existing) await diaryManager.execute(new DeleteDiarySummaryCommand({ userId: c.userId, kind: 'week', periodStart: week, status: 'ready' }))

    // A final week is a source of the year story: the story retells it, so it goes too and is written again.
    let yearDeleted = false
    if (existing?.stats?.final === true) {
      const story = await diaryManager.execute(
        new ListDiarySummariesQuery({ userId: c.userId, kind: 'year', from: `${year}-01-01`, to: `${year}-01-01`, limit: 1 }),
      )
      if (story.summaries[0]) {
        await diaryManager.execute(new DeleteDiarySummaryCommand({ userId: c.userId, kind: 'year', periodStart: `${year}-01-01`, status: 'ready' }))
        await diaryManager.execute(new MarkDiarySummaryForRecomputeCommand({ userId: c.userId, kind: 'year', periodStart: `${year}-01-01` }))
        yearDeleted = true
      }
    }

    // A finished week within the window is written again by the scheduler; the current one by the person's button.
    const windowStart = addDaysToDate(currentWeek, -7 * PROCESSES_CONFIG.DIARY.RECOMPUTE_WEEKS)
    const scheduled = week < currentWeek && week >= windowStart
    if (scheduled) await diaryManager.execute(new MarkDiarySummaryForRecomputeCommand({ userId: c.userId, kind: 'week', periodStart: week }))

    return { success: true, weekDeleted: existing !== null, yearDeleted, scheduled }
  }
}
