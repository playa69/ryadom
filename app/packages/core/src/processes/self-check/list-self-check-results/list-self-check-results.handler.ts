import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { selfCheckManager } from '../../../managers/self-check-manager'
import { ListSelfCheckResultsQuery } from '../../../managers/self-check-manager'
import { ListSelfCheckResultsOperation } from './list-self-check-results.operation'
import { ListSelfCheckResultsOperationErrorCode, type ListSelfCheckResultsResult } from './list-self-check-results.types'

@requestHandler(ListSelfCheckResultsOperation)
export class ListSelfCheckResultsOperationHandler implements RequestHandler<ListSelfCheckResultsOperation, ListSelfCheckResultsResult> {
  async handle(c: ListSelfCheckResultsOperation): Promise<ListSelfCheckResultsResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted) return { success: false, error: ListSelfCheckResultsOperationErrorCode.USER_NOT_FOUND }
    const limit = Math.min(Math.max(c.limit ?? 50, 1), 100)
    // One more than asked, to know whether a next page exists.
    const { results } = await selfCheckManager.execute(
      new ListSelfCheckResultsQuery({ userId: c.userId, testId: c.testId, before: c.before, limit: limit + 1 }),
    )
    const page = results.slice(0, limit)
    return { success: true, results: page, nextBefore: results.length > limit ? (page.at(-1)?.takenAt ?? null) : null }
  }
}
