import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { StoreUserDeviceCommandResult } from './store-user-device.types'

export interface StoreUserDeviceCommandData {
  recordId: string
  userId: string
  deviceId: string
  keyHash: string
}

export class StoreUserDeviceCommand extends RequestData<StoreUserDeviceCommandResult> {
  /** Survives minification: StoreUserDeviceCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'StoreUserDeviceCommand'

  public readonly recordId: string
  public readonly userId: string
  public readonly deviceId: string
  @hasPII(true)
  public readonly keyHash: string

  constructor(data: StoreUserDeviceCommandData) {
    super()
    this.recordId = data.recordId
    this.userId = data.userId
    this.deviceId = data.deviceId
    this.keyHash = data.keyHash
  }
}
