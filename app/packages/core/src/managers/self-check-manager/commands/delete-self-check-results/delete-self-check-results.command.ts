import { RequestData } from 'mediatr-ts'
import type { DeleteSelfCheckResultsCommandResult } from './delete-self-check-results.types'

export interface DeleteSelfCheckResultsCommandData {
  userId: string
  resultId?: string
  testId?: string
}

export class DeleteSelfCheckResultsCommand extends RequestData<DeleteSelfCheckResultsCommandResult> {
  /** Survives build minification: DeleteSelfCheckResultsCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteSelfCheckResultsCommand'

  public readonly userId: string
  public readonly resultId?: string
  public readonly testId?: string

  constructor(data: DeleteSelfCheckResultsCommandData) {
    super()
    this.userId = data.userId
    this.resultId = data.resultId
    this.testId = data.testId
  }
}
