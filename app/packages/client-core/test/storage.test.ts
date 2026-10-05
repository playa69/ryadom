/**
 * Browser session storage: the key names are the whole point. localStorage belongs to the origin, so
 * two clients on one host (`/web` and `/app`) must write different keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalSessionStorage } from '../src/storage'

/** localStorage in memory, with its keys visible. */
function stubLocalStorage(): Map<string, string> {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  })
  return data
}

const USER = { id: 'u1', email: null, name: null } as never
const DEVICE = { deviceId: 'd1', deviceKey: 'k1' }

let data: Map<string, string>

beforeEach(() => {
  data = stubLocalStorage()
})
afterEach(() => vi.unstubAllGlobals())

describe('createLocalSessionStorage', () => {
  it('по умолчанию пишет прежние (legacy) ключи, которые держит и PWA', async () => {
    const storage = createLocalSessionStorage()
    await storage.setRefreshToken('t')
    await storage.setDevice(DEVICE)
    await storage.setUser(USER)
    expect([...data.keys()].sort()).toEqual(['ryadom.user', 'ryadom_device', 'ryadom_refreshToken'])
  })

  it('со своим пространством имён пишет только свои ключи', async () => {
    const storage = createLocalSessionStorage('ryadom.web.', 'ryadom.web.user')
    await storage.setRefreshToken('t')
    await storage.setDevice(DEVICE)
    await storage.setUser(USER)
    expect([...data.keys()].sort()).toEqual(['ryadom.web.device', 'ryadom.web.refreshToken', 'ryadom.web.user'])
  })

  it('два клиента на одном origin не видят и не затирают сессии друг друга', async () => {
    const pwa = createLocalSessionStorage()
    const web = createLocalSessionStorage('ryadom.web.', 'ryadom.web.user')

    await pwa.setRefreshToken('pwa-token')
    expect(await web.getRefreshToken()).toBeNull()

    await web.setRefreshToken('web-token')
    expect(await pwa.getRefreshToken()).toBe('pwa-token')
    expect(await web.getRefreshToken()).toBe('web-token')

    await pwa.setDevice(DEVICE)
    expect(await web.getDevice()).toBeNull()
    await web.setUser(USER)
    expect(await pwa.getUser()).toBeNull()

    // Signing one client out leaves the other signed in.
    await web.removeRefreshToken()
    expect(await web.getRefreshToken()).toBeNull()
    expect(await pwa.getRefreshToken()).toBe('pwa-token')
  })
})
