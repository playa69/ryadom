import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { StoreUserCredentialsCommandResult } from './store-user-credentials.types'

export interface StoreUserCredentialsCommandData {
  credentialsId: string
  userId: string
  passwordHash: string
}

export class StoreUserCredentialsCommand extends RequestData<StoreUserCredentialsCommandResult> {
  /** Survives minification: StoreUserCredentialsCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'StoreUserCredentialsCommand'

  public readonly credentialsId: string
  public readonly userId: string

  @hasPII(true)
  public readonly passwordHash: string

  constructor(data: StoreUserCredentialsCommandData) {
    super()
    this.credentialsId = data.credentialsId
    this.userId = data.userId
    this.passwordHash = data.passwordHash
  }
}
