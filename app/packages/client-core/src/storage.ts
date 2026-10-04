import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import type { AuthUserApiResponse } from '@ryadom/contracts/api/auth/shared'

/** The user in the store: sign-in returns a basic profile, the profile screen loads the rest. */
export type User = AuthUserApiResponse & Partial<Pick<MeApiResponse, 'isEmailConfirmed' | 'createdAt'>>

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
}

/**
 * Browser storage. The refresh token in localStorage is readable by any script on the origin, so
 * the page must run under a CSP without `unsafe-inline` for scripts.
 */
export function createLocalSessionStorage(prefix = 'ryadom_'): SessionStorage {
  const refreshKey = `${prefix}refreshToken`
  const userKey = 'ryadom.user'
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
  }
}
