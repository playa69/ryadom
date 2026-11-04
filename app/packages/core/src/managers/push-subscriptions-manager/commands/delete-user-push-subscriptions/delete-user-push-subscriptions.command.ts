import { RequestData } from 'mediatr-ts'
import type { DeleteUserPushSubscriptionsCommandResult } from './delete-user-push-subscriptions.types'

export interface DeleteUserPushSubscriptionsCommandData {
  userId: string
}

/** Every device of the account: the account is being erased (the row is only anonymized, so no cascade happens). */
export class DeleteUserPushSubscriptionsCommand extends RequestData<DeleteUserPushSubscriptionsCommandResult> {
  /** Survives minification: DeleteUserPushSubscriptionsCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteUserPushSubscriptionsCommand'

  public readonly userId: string

  constructor(data: DeleteUserPushSubscriptionsCommandData) {
    super()
    this.userId = data.userId
  }
}
