export enum StoreUserDeviceCommandErrorCode {
  DEVICE_ALREADY_EXISTS = 'DEVICE_ALREADY_EXISTS',
}

export type StoreUserDeviceCommandResult =
  { success: true } | { success: false; error: StoreUserDeviceCommandErrorCode }
