import { RequestData } from 'mediatr-ts'
import type { MarkUserEmailConfirmedCommandResult } from './mark-user-email-confirmed.types'

export interface MarkUserEmailConfirmedCommandData {
  userId: string
}

export class MarkUserEmailConfirmedCommand extends RequestData<MarkUserEmailConfirmedCommandResult> {
  /** Survives minification: MarkUserEmailConfirmedCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'MarkUserEmailConfirmedCommand'

  public readonly userId: string

  constructor(data: MarkUserEmailConfirmedCommandData) {
    super()
    this.userId = data.userId
  }
}
