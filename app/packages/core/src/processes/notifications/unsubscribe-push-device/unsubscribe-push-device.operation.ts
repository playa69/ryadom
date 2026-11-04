import { RequestData } from 'mediatr-ts'
import type { UnsubscribePushDeviceResult } from './unsubscribe-push-device.types'

export interface UnsubscribePushDeviceOperationData {
  userId: string
  subscriptionId: string
}

export class UnsubscribePushDeviceOperation extends RequestData<UnsubscribePushDeviceResult> {
  /** Survives minification: UnsubscribePushDeviceOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'UnsubscribePushDeviceOperation'

  public readonly userId: string
  public readonly subscriptionId: string

  constructor(data: UnsubscribePushDeviceOperationData) {
    super()
    this.userId = data.userId
    this.subscriptionId = data.subscriptionId
  }
}
