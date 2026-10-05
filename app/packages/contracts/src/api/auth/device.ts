import type { LoginApiResponse } from './shared'

/**
 * `POST /api/auth/device` — sign-in without an email: the anonymous way in.
 *
 * On first launch the app makes a random `deviceId` and a secret `deviceKey` (256 random bits,
 * URL-safe base64) and keeps both. The first call with a new `deviceId` makes an account that has no
 * address, name or password; every later call with the same pair returns that account again. The
 * key proves the device is the one that made it, so it must not leave the device or be reused.
 * Linking an address (`POST /api/auth/email/link`) turns the account into an ordinary one.
 *
 * A request whose `deviceId` or `deviceKey` is not in the expected shape is a 400. A wrong key for a
 * known device and a blocked account are the same 401: the answer does not say which.
 */

export interface DeviceLoginApiRequest {
  /** 16 to 64 URL-safe characters. */
  deviceId: string
  /** 32 to 128 URL-safe characters. */
  deviceKey: string
}

export interface DeviceLoginApiResponse extends LoginApiResponse {
  /** true when this call made the account. */
  isNewAccount: boolean
}
