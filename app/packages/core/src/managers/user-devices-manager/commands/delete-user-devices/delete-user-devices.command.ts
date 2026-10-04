import { RequestData } from 'mediatr-ts'
import type { DeleteUserDevicesCommandResult } from './delete-user-devices.types'

export interface DeleteUserDevicesCommandData {
  userId: string
}

export class DeleteUserDevicesCommand extends RequestData<DeleteUserDevicesCommandResult> {
  /** Survives minification: DeleteUserDevicesCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteUserDevicesCommand'

  public readonly userId: string

  constructor(data: DeleteUserDevicesCommandData) {
    super()
    this.userId = data.userId
  }
}
