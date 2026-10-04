import { RequestData } from 'mediatr-ts'
import type { SetUserActiveCommandResult } from './set-user-active.types'

export interface SetUserActiveCommandData {
  userId: string
  isActive: boolean
}

export class SetUserActiveCommand extends RequestData<SetUserActiveCommandResult> {
  /** Survives minification: SetUserActiveCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'SetUserActiveCommand'

  public readonly userId: string
  public readonly isActive: boolean

  constructor(data: SetUserActiveCommandData) {
    super()
    this.userId = data.userId
    this.isActive = data.isActive
  }
}
