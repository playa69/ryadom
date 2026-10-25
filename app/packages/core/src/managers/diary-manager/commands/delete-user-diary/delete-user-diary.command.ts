import { RequestData } from 'mediatr-ts'
import type { DeleteUserDiaryCommandResult } from './delete-user-diary.types'

export interface DeleteUserDiaryCommandData {
  userId: string
}

export class DeleteUserDiaryCommand extends RequestData<DeleteUserDiaryCommandResult> {
  /** Survives build minification: DeleteUserDiaryCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteUserDiaryCommand'

  public readonly userId: string

  constructor(data: DeleteUserDiaryCommandData) {
    super()
    this.userId = data.userId
  }
}
