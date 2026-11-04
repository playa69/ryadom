import { RequestData } from 'mediatr-ts'
import type { PushChannel } from '@ryadom/db/schema'
import { hasPII } from '../../../shared'
import type { SubscribePushDeviceResult } from './subscribe-push-device.types'

export interface SubscribePushDeviceOperationData {
  userId: string
  /** The session of the request: notifications stop when it ends. */
  sessionId: string
  channel: PushChannel
  token: string
  projectId: string
  appId: string
}

export class SubscribePushDeviceOperation extends RequestData<SubscribePushDeviceResult> {
  /** Survives minification: SubscribePushDeviceOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'SubscribePushDeviceOperation'

  public readonly userId: string
  public readonly sessionId: string
  public readonly channel: PushChannel

  @hasPII(true)
  public readonly token: string

  public readonly projectId: string
  public readonly appId: string

  constructor(data: SubscribePushDeviceOperationData) {
    super()
    this.userId = data.userId
    this.sessionId = data.sessionId
    this.channel = data.channel
    this.token = data.token
    this.projectId = data.projectId
    this.appId = data.appId
  }
}
