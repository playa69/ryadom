import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { selfCheckManager } from '../../../managers/self-check-manager'
import { LatestSelfCheckResultsQuery } from '../../../managers/self-check-manager'
import { LatestSelfCheckResultsOperation } from './latest-self-check-results.operation'
import {
  LatestSelfCheckResultsOperationErrorCode,
  type LatestSelfCheckResultsResult,
} from './latest-self-check-results.types'

@requestHandler(LatestSelfCheckResultsOperation)
export class LatestSelfCheckResultsOperationHandler implements RequestHandler<
  LatestSelfCheckResultsOperation,
  LatestSelfCheckResultsResult
> {
  async handle(c: LatestSelfCheckResultsOperation): Promise<LatestSelfCheckResultsResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted)
      return { success: false, error: LatestSelfCheckResultsOperationErrorCode.USER_NOT_FOUND }
    const { results } = await selfCheckManager.execute(new LatestSelfCheckResultsQuery({ userId: c.userId }))
    return { success: true, results }
  }
}
