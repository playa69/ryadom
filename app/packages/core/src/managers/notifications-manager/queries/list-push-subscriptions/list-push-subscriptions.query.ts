import { RequestData } from 'mediatr-ts'
import type { ListPushSubscriptionsQueryResult } from './list-push-subscriptions.types'

export interface ListPushSubscriptionsQueryData {
  userId: string
}

export class ListPushSubscriptionsQuery extends RequestData<ListPushSubscriptionsQueryResult> {
  /** Survives build minification: ListPushSubscriptionsQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListPushSubscriptionsQuery'

  public readonly userId: string

  constructor(data: ListPushSubscriptionsQueryData) {
    super()
    this.userId = data.userId
  }
}
