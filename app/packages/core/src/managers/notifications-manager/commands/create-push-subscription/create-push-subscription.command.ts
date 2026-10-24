import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { PushChannel } from '@ryadom/db/schema'
import type { CreatePushSubscriptionCommandResult } from './create-push-subscription.types'

export interface CreatePushSubscriptionCommandData {
  id: string
  userId: string
  channel: PushChannel
  endpoint?: string | null
  p256dh?: string | null
  auth?: string | null
  deviceLabel?: string | null
}

export class CreatePushSubscriptionCommand extends RequestData<CreatePushSubscriptionCommandResult> {
  /** Survives build minification: CreatePushSubscriptionCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreatePushSubscriptionCommand'

  public readonly id: string
  public readonly userId: string
  public readonly channel: PushChannel
  @hasPII(true)
  public readonly endpoint?: string | null
  @hasPII(true)
  public readonly p256dh?: string | null
  @hasPII(true)
  public readonly auth?: string | null
  public readonly deviceLabel?: string | null

  constructor(data: CreatePushSubscriptionCommandData) {
    super()
    this.id = data.id
    this.userId = data.userId
    this.channel = data.channel
    this.endpoint = data.endpoint
    this.p256dh = data.p256dh
    this.auth = data.auth
    this.deviceLabel = data.deviceLabel
  }
}
