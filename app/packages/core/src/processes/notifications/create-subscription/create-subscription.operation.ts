import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { PushChannel } from '@ryadom/db/schema'
import type { CreateSubscriptionResult } from './create-subscription.types'

export interface CreateSubscriptionOperationData {
  userId: string
  channel: PushChannel
  endpoint?: string
  p256dh?: string
  auth?: string
  deviceLabel?: string
}

export class CreateSubscriptionOperation extends RequestData<CreateSubscriptionResult> {
  /** Survives build minification: CreateSubscriptionOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateSubscriptionOperation'

  public readonly userId: string
  public readonly channel: PushChannel
  @hasPII(true)
  public readonly endpoint?: string
  @hasPII(true)
  public readonly p256dh?: string
  @hasPII(true)
  public readonly auth?: string
  public readonly deviceLabel?: string

  constructor(data: CreateSubscriptionOperationData) {
    super()
    this.userId = data.userId
    this.channel = data.channel
    this.endpoint = data.endpoint
    this.p256dh = data.p256dh
    this.auth = data.auth
    this.deviceLabel = data.deviceLabel
  }
}
