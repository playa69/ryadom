import { RequestData } from 'mediatr-ts'
import type { DeleteUserNotificationsCommandResult } from './delete-user-notifications.types'

export interface DeleteUserNotificationsCommandData {
  userId: string
}

export class DeleteUserNotificationsCommand extends RequestData<DeleteUserNotificationsCommandResult> {
  /** Survives build minification: DeleteUserNotificationsCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteUserNotificationsCommand'

  public readonly userId: string

  constructor(data: DeleteUserNotificationsCommandData) {
    super()
    this.userId = data.userId
  }
}
