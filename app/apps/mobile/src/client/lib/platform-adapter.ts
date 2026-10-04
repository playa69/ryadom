import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Preferences } from '@capacitor/preferences'
import {
  createClient,
  type DeviceCredentials,
  type SessionStorage,
  type User,
} from '@ryadom/client-core/index'
import { getVersionHeaders, notifyUpgradeRequired } from './app-update'
import { getApiBase, getWsBase } from './env'
import { isAndroid, isIosNative } from './platform'

/**
 * Everything Capacitor- and Vite-specific that the shared client (@ryadom/client-core) needs, and
 * the single client instance of this app. Screens and the store go through api.ts / auth.ts, never
 * through client-core's factory, so there is exactly one session in memory.
 *
 * Where the tokens and the user live:
 * - the refresh token goes into the platform's secure storage (Android Keystore, iOS Keychain via
 *   `@aparajita/capacitor-secure-storage`). In a browser the plugin stores it in localStorage
 *   unencrypted, so it gets the same protection as the rest of the PWA: a CSP without
 *   `unsafe-inline`;
 * - the access token lives in memory only (inside the client);
 * - the user goes into Preferences, so the screen is not empty with no network.
 */

export const ACCOUNT_UNAVAILABLE_EVENT = 'ryadom:account-unavailable'

const KEY_PREFIX = 'ryadom_'
const REFRESH_TOKEN_KEY = 'refreshToken'
const USER_KEY = 'ryadom.user'
const DEVICE_KEY = 'device'

let prefixReady: Promise<void> | null = null

/**
 * Sets the key prefix, once, before the first access to the storage.
 *
 * The plugin itself is deliberately not returned from here: Capacitor answers a native call for
 * any property access on a plugin, `then` included. A promise resolved with the plugin takes it
 * for a thenable and calls `SecureStorage.then()`, which is "not implemented", and then the whole
 * storage stops working.
 */
async function ensurePrefix(): Promise<void> {
  if (!prefixReady) {
    prefixReady = SecureStorage.setKeyPrefix(KEY_PREFIX).catch((error: unknown) => {
      prefixReady = null
      throw error
    })
  }
  await prefixReady
}

const storage: SessionStorage = {
  async getRefreshToken() {
    await ensurePrefix()
    const value = await SecureStorage.get(REFRESH_TOKEN_KEY, false)
    return typeof value === 'string' && value ? value : null
  },
  async setRefreshToken(token) {
    await ensurePrefix()
    await SecureStorage.set(REFRESH_TOKEN_KEY, token, false)
  },
  async removeRefreshToken() {
    await ensurePrefix()
    await SecureStorage.remove(REFRESH_TOKEN_KEY)
  },
  async getUser() {
    try {
      const { value } = await Preferences.get({ key: USER_KEY })
      return value ? (JSON.parse(value) as User) : null
    } catch {
      return null
    }
  },
  async setUser(user) {
    try {
      if (user) await Preferences.set({ key: USER_KEY, value: JSON.stringify(user) })
      else await Preferences.remove({ key: USER_KEY })
    } catch {
      // Storage is unavailable, so the user only survives until the app is closed.
    }
  },
  /** The anonymous identity: a secret, so secure storage like the refresh token, not Preferences. */
  async getDevice() {
    await ensurePrefix()
    const value = await SecureStorage.get(DEVICE_KEY, false)
    if (typeof value !== 'string' || !value) return null
    try {
      const device = JSON.parse(value) as Partial<DeviceCredentials>
      return typeof device.deviceId === 'string' && typeof device.deviceKey === 'string'
        ? { deviceId: device.deviceId, deviceKey: device.deviceKey }
        : null
    } catch {
      return null
    }
  },
  async setDevice(device) {
    await ensurePrefix()
    if (device) await SecureStorage.set(DEVICE_KEY, JSON.stringify(device), false)
    else await SecureStorage.remove(DEVICE_KEY)
  },
}

/**
 * Ending the session lives in the store (store.tsx), which imports the API layer, so the API layer
 * cannot import it back. The store subscribes at startup instead.
 */
let sessionEndHandler: (() => void) | null = null

export function setSessionEndHandler(handler: (() => void) | null): void {
  sessionEndHandler = handler
}

export const client = createClient({
  apiBase: getApiBase,
  wsBase: getWsBase,
  storage,
  // The same code runs in both store builds and as a PWA; the logs tell them apart by this.
  clientId: isAndroid() ? 'ryadom-android' : isIosNative() ? 'ryadom-ios' : 'ryadom-pwa',
  versionHeaders: getVersionHeaders,
  onUpgradeRequired: notifyUpgradeRequired,
  onAccountUnavailable: (code) => {
    window.dispatchEvent(new CustomEvent(ACCOUNT_UNAVAILABLE_EVENT, { detail: { code } }))
  },
  // The client has already dropped the tokens; the handler resets the store's state.
  onSessionEnd: () => sessionEndHandler?.(),
})
