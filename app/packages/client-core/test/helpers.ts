import type { DeviceCredentials } from '../src/device'
import type { SessionStorage, User } from '../src/storage'

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A token shaped like the server's (header.payload.signature); the client never checks the signature. */
export function makeToken(subject: string, expiresInSeconds = 3600, nonce = ''): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds
  return `${encode({ alg: 'HS256' })}.${encode({ sub: subject, exp, n: nonce })}.signature`
}

export interface MemoryStorage extends SessionStorage {
  refreshToken: string | null
  user: User | null
  device: DeviceCredentials | null
  /** Makes every write to the refresh token fail, like a blocked or full browser storage. */
  failWrites: boolean
}

/** Stands in for localStorage: one object that several clients (tabs) can share. */
export function memoryStorage(): MemoryStorage {
  const storage: MemoryStorage = {
    refreshToken: null,
    user: null,
    device: null,
    failWrites: false,
    async getRefreshToken() {
      return storage.refreshToken
    },
    async setRefreshToken(token) {
      if (storage.failWrites) throw new Error('quota exceeded')
      storage.refreshToken = token
    },
    async removeRefreshToken() {
      storage.refreshToken = null
    },
    async getUser() {
      return storage.user
    },
    async setUser(user) {
      storage.user = user
    },
    async getDevice() {
      return storage.device
    },
    async setDevice(device) {
      storage.device = device
    },
  }
  return storage
}

export const userOf = (id: string): User => ({ id, email: `${id}@example.com`, name: id })

export function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ status: true, result }), { status: 200 })
}
