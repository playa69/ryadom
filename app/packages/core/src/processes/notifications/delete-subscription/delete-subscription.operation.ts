import { RequestData } from 'mediatr-ts'
import type { DeleteSubscriptionResult } from './delete-subscription.types'

export interface DeleteSubscriptionOperationData {
  userId: string
  id: string
}

export class DeleteSubscriptionOperation extends RequestData<DeleteSubscriptionResult> {
  /** Survives build minification: DeleteSubscriptionOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteSubscriptionOperation'

  public readonly userId: string
  public readonly id: string

  constructor(data: DeleteSubscriptionOperationData) {
    super()
    this.userId = data.userId
    this.id = data.id
  }
}
