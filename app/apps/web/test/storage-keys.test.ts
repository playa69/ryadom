/**
 * The web client and the PWA share one origin on the production host (`/web` and `/app`), so their
 * browser storage keys must not meet. The PWA and the store builds keep their original names; this
 * client lives in `ryadom.web.*`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalSessionStorage } from '@ryadom/client-core/storage'
import { WEB_PENDING_AUTH_KEY, WEB_STORAGE_PREFIX, WEB_USER_KEY, webDialogViewKey } from '../lib/storage-keys'

/**
 * Every key the PWA (apps/mobile) and the store builds write: the platform adapter's secure-storage
 * prefix and key names, its Preferences (Capacitor adds `CapacitorStorage.`), the update and install
 * banners. Renaming any of these would sign installed apps out, so they are listed here to be kept
 * apart from, not changed with, the web client.
 */
const PWA_KEYS = [
  'ryadom_refreshToken',
  'ryadom_device',
  'ryadom.user',
  'CapacitorStorage.ryadom.user',
  'CapacitorStorage.ryadom.env',
  'CapacitorStorage.ryadom.env.localApi',
  'ryadom.install.dismissedAt',
  'ryadom.update.lastVersionCode',
  'ryadom.update.nextJsVersion',
  'ryadom.update.dismissedVersionCode',
]
const PWA_PREFIXES = ['ryadom_', 'CapacitorStorage.', 'ryadom.update.', 'ryadom.install.']

describe('ключи хранилища web-клиента', () => {
  const webKeys = [WEB_USER_KEY, WEB_PENDING_AUTH_KEY, webDialogViewKey('d-1')]

  it('все в пространстве ryadom.web.', () => {
    for (const key of webKeys) expect(key.startsWith(WEB_STORAGE_PREFIX)).toBe(true)
    expect(WEB_STORAGE_PREFIX).toBe('ryadom.web.')
  })

  it('ни один не совпадает с ключами PWA и не лежит под их префиксами', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    })
    try {
      const storage = createLocalSessionStorage(WEB_STORAGE_PREFIX, WEB_USER_KEY)
      void storage.setRefreshToken('t')
      void storage.setDevice({ deviceId: 'd', deviceKey: 'k' })
      void storage.setUser({ id: 'u' } as never)
      const written = [...data.keys(), ...webKeys]
      expect(written.length).toBeGreaterThanOrEqual(5)
      for (const key of written) {
        expect(PWA_KEYS, key).not.toContain(key)
        for (const prefix of PWA_PREFIXES) expect(key.startsWith(prefix), `${key} / ${prefix}`).toBe(false)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ключ вида диалога зависит от диалога', () => {
    expect(webDialogViewKey('a')).not.toBe(webDialogViewKey('b'))
  })
})

beforeEach(() => undefined)
afterEach(() => undefined)
