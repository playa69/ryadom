import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diaryManager, ListDiarySummariesQuery } from '../../../managers/diary-manager'
import { userZone } from '../shared/user-zone'
import { ListWeekSummariesOperation } from './list-week-summaries.operation'
import { ListWeekSummariesOperationErrorCode, type ListWeekSummariesResult } from './list-week-summaries.types'

@requestHandler(ListWeekSummariesOperation)
export class ListWeekSummariesOperationHandler implements RequestHandler<ListWeekSummariesOperation, ListWeekSummariesResult> {
  async handle(c: ListWeekSummariesOperation): Promise<ListWeekSummariesResult> {
    if (!(await userZone(c.userId))) return { success: false, error: ListWeekSummariesOperationErrorCode.USER_NOT_FOUND }
    const pageSize = 20
    const { summaries } = await diaryManager.execute(
      new ListDiarySummariesQuery({ userId: c.userId, kind: 'week', before: c.before, limit: pageSize + 1 }),
    )
    const page = summaries.slice(0, pageSize)
    return {
      success: true,
      summaries: page,
      nextBefore: summaries.length > pageSize ? (page[page.length - 1]?.periodStart ?? null) : null,
    }
  }
}
