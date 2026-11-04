import { RequestData } from 'mediatr-ts'
import type { PushChannel } from '@ryadom/db/schema'
import { hasPII } from '../../../../shared'
import type { StorePushSubscriptionCommandResult } from './store-push-subscription.types'

export interface StorePushSubscriptionCommandData {
  /** Used only when the token is new: a token that is already known keeps the id it has. */
  subscriptionId: string
  userId: string
  sessionId: string
  channel: PushChannel
  token: string
  projectId: string
  appId: string
  now: Date
}

export class StorePushSubscriptionCommand extends RequestData<StorePushSubscriptionCommandResult> {
  /** Survives minification: StorePushSubscriptionCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'StorePushSubscriptionCommand'

  public readonly subscriptionId: string
  public readonly userId: string
  public readonly sessionId: string
  public readonly channel: PushChannel

  @hasPII(true)
  public readonly token: string

  public readonly projectId: string
  public readonly appId: string
  public readonly now: Date

  constructor(data: StorePushSubscriptionCommandData) {
    super()
    this.subscriptionId = data.subscriptionId
    this.userId = data.userId
    this.sessionId = data.sessionId
    this.channel = data.channel
    this.token = data.token
    this.projectId = data.projectId
    this.appId = data.appId
    this.now = data.now
  }
}
