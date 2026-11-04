import { RequestData } from 'mediatr-ts'
import type { ListActivePushSubscriptionsQueryResult } from './list-active-push-subscriptions.types'

export interface ListActivePushSubscriptionsQueryData {
  userId: string
  now: Date
}

/** The devices a notification to the person goes to: subscriptions of sessions that are still open, newest first. */
export class ListActivePushSubscriptionsQuery extends RequestData<ListActivePushSubscriptionsQueryResult> {
  /** Survives minification: ListActivePushSubscriptionsQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'ListActivePushSubscriptionsQuery'

  public readonly userId: string
  public readonly now: Date

  constructor(data: ListActivePushSubscriptionsQueryData) {
    super()
    this.userId = data.userId
    this.now = data.now
  }
}
