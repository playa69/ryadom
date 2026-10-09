/**
 * A browser tab cannot ask whether the PWA is installed, so install-prompt.ts remembers it in
 * localStorage. Each `load()` is a fresh page: the module is evaluated again, as in a new tab,
 * while the storage and the platform flags carry over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ standalone: false }))
vi.mock('../src/client/lib/platform', () => ({
  isWebBuild: () => true,
  isStandalone: () => platform.standalone,
}))

const INSTALLED_KEY = 'ryadom.install.installedAt'

let storage: Map<string, string>
let win: EventTarget

beforeEach(() => {
  platform.standalone = false
  storage = new Map()
  win = new EventTarget()
  vi.stubGlobal('window', win)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function load() {
  // The previous page is gone, so its listeners are gone too.
  win = new EventTarget()
  vi.stubGlobal('window', win)
  vi.resetModules()
  return import('../src/client/lib/install-prompt')
}

function offerInstall() {
  const offer = new Event('beforeinstallprompt', { cancelable: true })
  win.dispatchEvent(offer)
  return offer
}

describe('установленное приложение', () => {
  it('по умолчанию не установлено', async () => {
    const { isAppInstalled } = await import('../src/client/lib/install-prompt')
    expect(isAppInstalled()).toBe(false)
  })

  it('после appinstalled установлено, и вкладка, открытая позже, это знает', async () => {
    const first = await import('../src/client/lib/install-prompt')
    const changed = vi.fn()
    first.onInstallPromptChange(changed)

    win.dispatchEvent(new Event('appinstalled'))

    expect(first.isAppInstalled()).toBe(true)
    expect(changed).toHaveBeenCalled()
    expect((await load()).isAppInstalled()).toBe(true)
  })

  it('запуск в окне приложения запоминается для вкладок браузера', async () => {
    platform.standalone = true
    expect((await load()).isAppInstalled()).toBe(true)

    platform.standalone = false
    expect((await load()).isAppInstalled()).toBe(true)
  })

  it('когда браузер снова предлагает установку, метка снимается и кнопка возвращается', async () => {
    storage.set(INSTALLED_KEY, '1')
    const { isAppInstalled, canPromptInstall } = await load()
    expect(isAppInstalled()).toBe(true)

    const offer = offerInstall()

    expect(offer.defaultPrevented).toBe(true)
    expect(isAppInstalled()).toBe(false)
    expect(canPromptInstall()).toBe(true)
    expect(storage.has(INSTALLED_KEY)).toBe(false)
  })

  it('без доступного хранилища ничего не падает', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })
    const { isAppInstalled } = await load()

    expect(() => win.dispatchEvent(new Event('appinstalled'))).not.toThrow()
    expect(isAppInstalled()).toBe(false)
  })
})
