import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { ReleaseUserEmailCommandResult } from './release-user-email.types'

export interface ReleaseUserEmailCommandData {
  userId: string
  /** The address the account is expected to hold, unconfirmed. */
  email: string
}

export class ReleaseUserEmailCommand extends RequestData<ReleaseUserEmailCommandResult> {
  /** Survives minification: ReleaseUserEmailCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'ReleaseUserEmailCommand'

  public readonly userId: string

  @hasPII()
  public readonly email: string

  constructor(data: ReleaseUserEmailCommandData) {
    super()
    this.userId = data.userId
    this.email = data.email
  }
}
