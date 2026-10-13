import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import type { AuthUserApiResponse } from '@ryadom/contracts/api/auth/shared'
import type { DeviceCredentials } from './device'

/**
 * The user in the store: sign-in returns a basic profile, the profile screen loads the rest.
 * `consentVersion` is what the app knows about the terms the person accepted: undefined until it has
 * asked the server or recorded the acceptance itself, null when the server has none on record.
 * `memoryEnabled` is the last thing the app heard about the person's switch "Запоминать" (from a
 * dialog start or the memory screen): it decides whether home offers a conversation "without memory".
 * Only the switch, never what is remembered.
 */
export type User = AuthUserApiResponse &
  Partial<Pick<MeApiResponse, 'isEmailConfirmed' | 'createdAt' | 'consentVersion' | 'voice'>> & {
    memoryEnabled?: boolean
  }

/**
 * Where the refresh token and the user live. The app supplies it: the platform's secure storage on
 * a phone (Android Keystore, iOS Keychain), localStorage in a browser. The access token is never
 * stored: it lives in memory for 15 minutes, and after a restart the first request gets a 401 and
 * refreshes it.
 *
 * Every method may reject; the client treats a failed read as "no session" and a failed write as
 * "the session only lasts until the tab or app is closed".
 */
export interface SessionStorage {
  getRefreshToken(): Promise<string | null>
  setRefreshToken(token: string): Promise<void>
  removeRefreshToken(): Promise<void>
  getUser(): Promise<User | null>
  setUser(user: User | null): Promise<void>
  /**
   * The anonymous identity of this device. Unlike the session it survives signing out: it is how an
   * anonymous account is found again. A secret, so the same protection as the refresh token.
   */
  getDevice(): Promise<DeviceCredentials | null>
  setDevice(device: DeviceCredentials | null): Promise<void>
}

/**
 * Browser storage. The refresh token in localStorage is readable by any script on the origin, so
 * the page must run under a CSP without `unsafe-inline` for scripts.
 *
 * localStorage belongs to the ORIGIN, not to a path: clients published on one host under different
 * prefixes (`/web`, `/app`) see the same keys. Two clients writing the same refresh token key would
 * overwrite each other's session, and the API treats a replay of a rotated token as theft and ends
 * ALL of the account's sessions. So each client names its own keys:
 * - `prefix` is put in front of `refreshToken` and `device`;
 * - `userKey` is the whole key of the cached user.
 * The defaults are the original (legacy) names, which the PWA and the store builds keep using
 * through the platform adapter (`ryadom_refreshToken`, `ryadom_device`, `ryadom.user`).
 */
export function createLocalSessionStorage(prefix = 'ryadom_', userKey = 'ryadom.user'): SessionStorage {
  const refreshKey = `${prefix}refreshToken`
  const deviceKey = `${prefix}device`
  return {
    async getRefreshToken() {
      const value = localStorage.getItem(refreshKey)
      return value ? value : null
    },
    async setRefreshToken(token) {
      localStorage.setItem(refreshKey, token)
    },
    async removeRefreshToken() {
      localStorage.removeItem(refreshKey)
    },
    async getUser() {
      try {
        const raw = localStorage.getItem(userKey)
        return raw ? (JSON.parse(raw) as User) : null
      } catch {
        return null
      }
    },
    async setUser(user) {
      if (user) localStorage.setItem(userKey, JSON.stringify(user))
      else localStorage.removeItem(userKey)
    },
    async getDevice() {
      try {
        const raw = localStorage.getItem(deviceKey)
        const device = raw ? (JSON.parse(raw) as Partial<DeviceCredentials>) : null
        return typeof device?.deviceId === 'string' && typeof device.deviceKey === 'string'
          ? { deviceId: device.deviceId, deviceKey: device.deviceKey }
          : null
      } catch {
        return null
      }
    },
    async setDevice(device) {
      if (device) localStorage.setItem(deviceKey, JSON.stringify(device))
      else localStorage.removeItem(deviceKey)
    },
  }
}
