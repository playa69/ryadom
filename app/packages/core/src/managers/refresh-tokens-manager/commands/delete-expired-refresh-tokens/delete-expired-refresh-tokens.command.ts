import { RequestData } from 'mediatr-ts'
import type { DeleteExpiredRefreshTokensCommandResult } from './delete-expired-refresh-tokens.types'

export interface DeleteExpiredRefreshTokensCommandData {
  before: Date
}

export class DeleteExpiredRefreshTokensCommand extends RequestData<DeleteExpiredRefreshTokensCommandResult> {
  /** Survives minification: DeleteExpiredRefreshTokensCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteExpiredRefreshTokensCommand'

  public readonly before: Date

  constructor(data: DeleteExpiredRefreshTokensCommandData) {
    super()
    this.before = data.before
  }
}
