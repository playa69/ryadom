import { RequestData } from 'mediatr-ts'
import type { PushChannel } from '@ryadom/db/schema'
import { hasPII } from '../../../../shared'
import type { GetPushSubscriptionByTokenQueryResult } from './get-push-subscription-by-token.types'

export interface GetPushSubscriptionByTokenQueryData {
  channel: PushChannel
  token: string
}

export class GetPushSubscriptionByTokenQuery extends RequestData<GetPushSubscriptionByTokenQueryResult> {
  /** Survives minification: GetPushSubscriptionByTokenQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetPushSubscriptionByTokenQuery'

  public readonly channel: PushChannel

  @hasPII(true)
  public readonly token: string

  constructor(data: GetPushSubscriptionByTokenQueryData) {
    super()
    this.channel = data.channel
    this.token = data.token
  }
}
