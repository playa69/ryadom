import type { UserDeviceDTO } from '../../shared/user-device.dto'

export enum GetUserDeviceQueryErrorCode {
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
}

export type GetUserDeviceQueryResult =
  { success: true; device: UserDeviceDTO } | { success: false; error: GetUserDeviceQueryErrorCode }
