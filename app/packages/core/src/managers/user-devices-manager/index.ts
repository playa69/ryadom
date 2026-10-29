// 1. Handler imports
import './commands/store-user-device/store-user-device.handler'
import './commands/delete-user-devices/delete-user-devices.handler'
import './queries/get-user-device/get-user-device.handler'
import './queries/has-user-devices/has-user-devices.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { StoreUserDeviceCommand } from './commands/store-user-device/store-user-device.command'
export type { StoreUserDeviceCommandData } from './commands/store-user-device/store-user-device.command'
export { DeleteUserDevicesCommand } from './commands/delete-user-devices/delete-user-devices.command'
export type { DeleteUserDevicesCommandData } from './commands/delete-user-devices/delete-user-devices.command'
export { GetUserDeviceQuery } from './queries/get-user-device/get-user-device.query'
export type { GetUserDeviceQueryData } from './queries/get-user-device/get-user-device.query'
export { HasUserDevicesQuery } from './queries/has-user-devices/has-user-devices.query'
export type { HasUserDevicesQueryData } from './queries/has-user-devices/has-user-devices.query'

// 3. Type re-exports
export type { StoreUserDeviceCommandResult } from './commands/store-user-device/store-user-device.types'
export { StoreUserDeviceCommandErrorCode } from './commands/store-user-device/store-user-device.types'
export type { DeleteUserDevicesCommandResult } from './commands/delete-user-devices/delete-user-devices.types'
export type { GetUserDeviceQueryResult } from './queries/get-user-device/get-user-device.types'
export { GetUserDeviceQueryErrorCode } from './queries/get-user-device/get-user-device.types'
export type { HasUserDevicesQueryResult } from './queries/has-user-devices/has-user-devices.types'
export type { UserDeviceDTO } from './shared/user-device.dto'

// 4. Union type
import type { StoreUserDeviceCommand } from './commands/store-user-device/store-user-device.command'
import type { DeleteUserDevicesCommand } from './commands/delete-user-devices/delete-user-devices.command'
import type { GetUserDeviceQuery } from './queries/get-user-device/get-user-device.query'
import type { HasUserDevicesQuery } from './queries/has-user-devices/has-user-devices.query'

export type UserDevicesManagerRequests =
  StoreUserDeviceCommand | DeleteUserDevicesCommand | GetUserDeviceQuery | HasUserDevicesQuery

// 5. Facade
export class UserDevicesManager implements IUserDevicesManager {
  async execute<T extends UserDevicesManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: UserDevicesManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IUserDevicesManager {
  execute<T extends UserDevicesManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const userDevicesManager: IUserDevicesManager = new UserDevicesManager()
