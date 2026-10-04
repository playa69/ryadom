import { RequestData } from 'mediatr-ts'
import type { DeleteUserCredentialsCommandResult } from './delete-user-credentials.types'

export interface DeleteUserCredentialsCommandData {
  userId: string
}

export class DeleteUserCredentialsCommand extends RequestData<DeleteUserCredentialsCommandResult> {
  /** Survives minification: DeleteUserCredentialsCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteUserCredentialsCommand'

  public readonly userId: string

  constructor(data: DeleteUserCredentialsCommandData) {
    super()
    this.userId = data.userId
  }
}
