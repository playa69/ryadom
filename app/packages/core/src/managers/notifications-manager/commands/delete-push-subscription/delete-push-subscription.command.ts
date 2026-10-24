import { RequestData } from 'mediatr-ts'
import type { DeletePushSubscriptionCommandResult } from './delete-push-subscription.types'

export interface DeletePushSubscriptionCommandData {
  id: string
  userId?: string
}

export class DeletePushSubscriptionCommand extends RequestData<DeletePushSubscriptionCommandResult> {
  /** Survives build minification: DeletePushSubscriptionCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeletePushSubscriptionCommand'

  public readonly id: string
  public readonly userId?: string

  constructor(data: DeletePushSubscriptionCommandData) {
    super()
    this.id = data.id
    this.userId = data.userId
  }
}
