import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { PushChannel } from '@ryadom/db/schema'
import type { FindPushSubscriptionQueryResult } from './find-push-subscription.types'

export interface FindPushSubscriptionQueryData {
  userId: string
  channel: PushChannel
  endpoint?: string
}

export class FindPushSubscriptionQuery extends RequestData<FindPushSubscriptionQueryResult> {
  /** Survives build minification: FindPushSubscriptionQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'FindPushSubscriptionQuery'

  public readonly userId: string
  public readonly channel: PushChannel
  @hasPII(true)
  public readonly endpoint?: string

  constructor(data: FindPushSubscriptionQueryData) {
    super()
    this.userId = data.userId
    this.channel = data.channel
    this.endpoint = data.endpoint
  }
}
