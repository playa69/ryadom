import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { MarkUserEmailConfirmedCommandResult } from './mark-user-email-confirmed.types'

export interface MarkUserEmailConfirmedCommandData {
  userId: string
  /** The address that was proven: the account must still hold exactly this one. */
  email: string
}

export class MarkUserEmailConfirmedCommand extends RequestData<MarkUserEmailConfirmedCommandResult> {
  /** Survives minification: MarkUserEmailConfirmedCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'MarkUserEmailConfirmedCommand'

  public readonly userId: string

  @hasPII()
  public readonly email: string

  constructor(data: MarkUserEmailConfirmedCommandData) {
    super()
    this.userId = data.userId
    this.email = data.email
  }
}
