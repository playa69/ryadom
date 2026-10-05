import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { ChangeUserEmailCommandResult } from './change-user-email.types'

export interface ChangeUserEmailCommandData {
  userId: string
  email: string
}

export class ChangeUserEmailCommand extends RequestData<ChangeUserEmailCommandResult> {
  /** Survives minification: ChangeUserEmailCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'ChangeUserEmailCommand'

  public readonly userId: string

  @hasPII()
  public readonly email: string

  constructor(data: ChangeUserEmailCommandData) {
    super()
    this.userId = data.userId
    this.email = data.email
  }
}
