import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { SetUserDeletionArchiveCommandResult } from './set-user-deletion-archive.types'

export interface SetUserDeletionArchiveCommandData {
  userId: string
  archive: Record<string, unknown>
}

export class SetUserDeletionArchiveCommand extends RequestData<SetUserDeletionArchiveCommandResult> {
  /** Survives minification: SetUserDeletionArchiveCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'SetUserDeletionArchiveCommand'

  public readonly userId: string

  @hasPII(true)
  public readonly archive: Record<string, unknown>

  constructor(data: SetUserDeletionArchiveCommandData) {
    super()
    this.userId = data.userId
    this.archive = data.archive
  }
}
