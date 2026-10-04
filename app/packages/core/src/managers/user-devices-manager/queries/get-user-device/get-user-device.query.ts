import { RequestData } from 'mediatr-ts'
import type { GetUserDeviceQueryResult } from './get-user-device.types'

export interface GetUserDeviceQueryData {
  deviceId: string
}

export class GetUserDeviceQuery extends RequestData<GetUserDeviceQueryResult> {
  /** Survives minification: GetUserDeviceQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetUserDeviceQuery'

  public readonly deviceId: string

  constructor(data: GetUserDeviceQueryData) {
    super()
    this.deviceId = data.deviceId
  }
}
