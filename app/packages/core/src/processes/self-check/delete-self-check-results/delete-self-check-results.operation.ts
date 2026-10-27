import { RequestData } from 'mediatr-ts'
import type { DeleteSelfCheckResultsResult } from './delete-self-check-results.types'

export interface DeleteSelfCheckResultsOperationData {
  userId: string
  resultId?: string
  testId?: string
}

export class DeleteSelfCheckResultsOperation extends RequestData<DeleteSelfCheckResultsResult> {
  /** Survives build minification: DeleteSelfCheckResultsOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteSelfCheckResultsOperation'

  public readonly userId: string
  public readonly resultId?: string
  public readonly testId?: string

  constructor(data: DeleteSelfCheckResultsOperationData) {
    super()
    this.userId = data.userId
    this.resultId = data.resultId
    this.testId = data.testId
  }
}
