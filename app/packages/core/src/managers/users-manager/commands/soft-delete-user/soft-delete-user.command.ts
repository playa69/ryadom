import { RequestData } from 'mediatr-ts'
import type { SoftDeleteUserCommandResult } from './soft-delete-user.types'

export interface SoftDeleteUserCommandData {
  userId: string
}

export class SoftDeleteUserCommand extends RequestData<SoftDeleteUserCommandResult> {
  /** Survives minification: SoftDeleteUserCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'SoftDeleteUserCommand'

  public readonly userId: string

  constructor(data: SoftDeleteUserCommandData) {
    super()
    this.userId = data.userId
  }
}
