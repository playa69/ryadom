import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { selfCheckManager } from '../../../managers/self-check-manager'
import { CountSelfCheckResultsQuery, DeleteSelfCheckResultsCommand } from '../../../managers/self-check-manager'
import { DeleteSelfCheckResultsOperation } from './delete-self-check-results.operation'
import { DeleteSelfCheckResultsOperationErrorCode, type DeleteSelfCheckResultsResult } from './delete-self-check-results.types'

@requestHandler(DeleteSelfCheckResultsOperation)
export class DeleteSelfCheckResultsOperationHandler implements RequestHandler<DeleteSelfCheckResultsOperation, DeleteSelfCheckResultsResult> {
  async handle(c: DeleteSelfCheckResultsOperation): Promise<DeleteSelfCheckResultsResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted) return { success: false, error: DeleteSelfCheckResultsOperationErrorCode.USER_NOT_FOUND }
    // One result, all of one test, or all: always only the person's own (the manager filters by the account).
    const scope = { userId: c.userId, resultId: c.resultId, testId: c.testId }
    const { count } = await selfCheckManager.execute(new CountSelfCheckResultsQuery(scope))
    await selfCheckManager.execute(new DeleteSelfCheckResultsCommand(scope))
    return { success: true, deleted: count }
  }
}
