import { RequestData } from 'mediatr-ts'
import type { HasUserDevicesQueryResult } from './has-user-devices.types'

export interface HasUserDevicesQueryData {
  userId: string
}

export class HasUserDevicesQuery extends RequestData<HasUserDevicesQueryResult> {
  /** Survives minification: HasUserDevicesQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'HasUserDevicesQuery'

  public readonly userId: string

  constructor(data: HasUserDevicesQueryData) {
    super()
    this.userId = data.userId
  }
}
