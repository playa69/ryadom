import type { UserDTO } from '../../../managers/users-manager'

export enum DeviceLoginOperationErrorCode {
  /** A device id that exists, with a key that does not match. */
  DEVICE_KEY_INVALID = 'DEVICE_KEY_INVALID',
  /** The account behind the device is blocked. */
  USER_INACTIVE = 'USER_INACTIVE',
}

export type DeviceLoginResult =
  | {
      success: true
      user: UserDTO
      /** true when this call made the account: the device had never signed in before. */
      isNewAccount: boolean
    }
  | { success: false; error: DeviceLoginOperationErrorCode }
