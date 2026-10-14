/**
 * How the web build tells it was opened as the Telegram Mini App, and what it remembers about a sign-out
 * there. The window is a stand-in: the address and sessionStorage are what Telegram's launch leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let session: Map<string, string>

function stubWindow(hash: string) {
  vi.stubGlobal('window', {
    location: { hash },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    },
  })
}

beforeEach(() => {
  session = new Map()
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const load = () => import('../src/client/lib/telegram')

describe('запуск из Telegram', () => {
  it('данные запуска в адресе — это Mini App', async () => {
    stubWindow('#tgWebAppData=query_id%3DAAH&tgWebAppVersion=8.0&tgWebAppPlatform=android')
    expect((await load()).isTelegramLaunch()).toBe(true)
  })

  it('после перезагрузки адрес чистый, но Telegram оставил копию в sessionStorage', async () => {
    stubWindow('')
    session.set(
      '__telegram__initParams',
      JSON.stringify({ tgWebAppData: 'query_id=AAH', tgWebAppVersion: '8.0' }),
    )
    expect((await load()).isTelegramLaunch()).toBe(true)
  })

  it('обычная вкладка браузера — не Mini App, и скрипт Telegram не грузится', async () => {
    stubWindow('#/home/')
    const telegram = await load()
    expect(telegram.isTelegramLaunch()).toBe(false)
    expect(await telegram.initTelegram()).toBeNull()
    expect(telegram.isTelegramMiniApp()).toBe(false)
    expect(telegram.telegramInitData()).toBeNull()
  })
})

describe('выход внутри Mini App', () => {
  it('запоминается до конца запуска и снимается входом', async () => {
    stubWindow('#tgWebAppData=x')
    const telegram = await load()
    expect(telegram.wasTelegramSignedOut()).toBe(false)
    telegram.markTelegramSignedOut(true)
    expect(telegram.wasTelegramSignedOut()).toBe(true)
    telegram.markTelegramSignedOut(false)
    expect(telegram.wasTelegramSignedOut()).toBe(false)
  })
})
