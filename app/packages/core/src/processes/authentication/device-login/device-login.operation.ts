import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { DeviceLoginResult } from './device-login.types'

export interface DeviceLoginOperationData {
  deviceId: string
  deviceKey: string
}

export class DeviceLoginOperation extends RequestData<DeviceLoginResult> {
  /** Survives minification: DeviceLoginOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeviceLoginOperation'

  public readonly deviceId: string

  @hasPII(true)
  public readonly deviceKey: string

  constructor(data: DeviceLoginOperationData) {
    super()
    this.deviceId = data.deviceId
    this.deviceKey = data.deviceKey
  }
}
