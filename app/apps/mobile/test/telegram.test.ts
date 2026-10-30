/**
 * How the web build tells it was opened as the Telegram Mini App, and what it remembers about a sign-out
 * there. The window is a stand-in: the address and sessionStorage are what Telegram's launch leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The SDK touches the document when it loads; the tests give the page a stand-in `Telegram.WebApp` instead.
vi.mock('@twa-dev/sdk', () => ({ default: {} }))

let session: Map<string, string>

function stubWindow(hash: string, telegram?: { startParam?: string }) {
  vi.stubGlobal('window', {
    location: { hash },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    },
    ...(telegram && {
      Telegram: {
        WebApp: {
          initData: 'query_id=AAH',
          initDataUnsafe: telegram.startParam === undefined ? {} : { start_param: telegram.startParam },
          ready: () => {},
          expand: () => {},
          isVersionAtLeast: () => false,
        },
      },
    }),
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

// `openspec/changes/add-telegram-start-param`, «Метка запуска Telegram Mini App»
describe('метка запуска Mini App', () => {
  it('запуск по ссылке с startapp отдаёт метку', async () => {
    stubWindow('#tgWebAppData=x', { startParam: 'tgads_oct' })
    const telegram = await load()
    expect(telegram.telegramStartParam()).toBeNull()
    await telegram.initTelegram()
    expect(telegram.telegramStartParam()).toBe('tgads_oct')
  })

  it('запуск без параметра (кнопка меню бота) метки не даёт', async () => {
    stubWindow('#tgWebAppData=x', {})
    const telegram = await load()
    await telegram.initTelegram()
    expect(telegram.isTelegramMiniApp()).toBe(true)
    expect(telegram.telegramStartParam()).toBeNull()
  })

  it('пустой параметр метки не даёт', async () => {
    stubWindow('#tgWebAppData=x', { startParam: '' })
    const telegram = await load()
    await telegram.initTelegram()
    expect(telegram.telegramStartParam()).toBeNull()
  })

  it('обычная вкладка браузера: метки нет', async () => {
    stubWindow('#/home/')
    const telegram = await load()
    await telegram.initTelegram()
    expect(telegram.telegramStartParam()).toBeNull()
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
