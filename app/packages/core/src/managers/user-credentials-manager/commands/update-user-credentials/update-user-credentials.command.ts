import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { UpdateUserCredentialsCommandResult } from './update-user-credentials.types'

export interface UpdateUserCredentialsCommandData {
  userId: string
  passwordHash: string
}

export class UpdateUserCredentialsCommand extends RequestData<UpdateUserCredentialsCommandResult> {
  /** Survives minification: UpdateUserCredentialsCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateUserCredentialsCommand'

  public readonly userId: string

  @hasPII(true)
  public readonly passwordHash: string

  constructor(data: UpdateUserCredentialsCommandData) {
    super()
    this.userId = data.userId
    this.passwordHash = data.passwordHash
  }
}
