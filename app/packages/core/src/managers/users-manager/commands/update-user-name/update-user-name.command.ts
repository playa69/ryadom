import { RequestData } from 'mediatr-ts'
import type { UpdateUserNameCommandResult } from './update-user-name.types'

export interface UpdateUserNameCommandData {
  userId: string
  name: string
}

export class UpdateUserNameCommand extends RequestData<UpdateUserNameCommandResult> {
  /** Survives minification: UpdateUserNameCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateUserNameCommand'

  public readonly userId: string
  public readonly name: string

  constructor(data: UpdateUserNameCommandData) {
    super()
    this.userId = data.userId
    this.name = data.name
  }
}
