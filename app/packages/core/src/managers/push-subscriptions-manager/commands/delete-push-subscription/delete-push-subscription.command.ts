import { RequestData } from 'mediatr-ts'
import type { DeletePushSubscriptionCommandResult } from './delete-push-subscription.types'

export interface DeletePushSubscriptionCommandData {
  subscriptionId: string
  /** Only a subscription of this account; null removes it whoever it belongs to (the push service forgot the token). */
  userId: string | null
}

export class DeletePushSubscriptionCommand extends RequestData<DeletePushSubscriptionCommandResult> {
  /** Survives minification: DeletePushSubscriptionCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeletePushSubscriptionCommand'

  public readonly subscriptionId: string
  public readonly userId: string | null

  constructor(data: DeletePushSubscriptionCommandData) {
    super()
    this.subscriptionId = data.subscriptionId
    this.userId = data.userId
  }
}
