import { afterEach, describe, expect, it, vi } from 'vitest'
import { micGuide, micGuideKind } from '../src/voice/mic-guide'
import { queryMicPermission, watchMicPermission } from '../src/voice/mic-permission'

// `openspec/changes/add-mic-permission-guide`, «Микрофон или голос недоступны»: the steps depend on the place.
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const YANDEX = 'Mozilla/5.0 (Linux; arm_64; Android 14) AppleWebKit/537.36 Chrome/128.0.0.0 YaBrowser/24.10.0 Mobile Safari/537.36'
const YA_APP = 'Mozilla/5.0 (Linux; arm_64; Android 14) AppleWebKit/537.36 Chrome/128.0.0.0 YaSearchApp/24.80 Mobile Safari/537.36'
const WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'

describe('micGuideKind', () => {
  it.each([
    [CHROME_ANDROID, false, 'chrome-android'],
    [SAFARI_IOS, false, 'safari-ios'],
    [YANDEX, false, 'yandex'],
    [YA_APP, false, 'embedded'],
    [CHROME_ANDROID, true, 'pwa'],
    // The store build's WebView looks like an embedded browser, but it has its own switch in the system settings.
    [WEBVIEW, true, 'pwa'],
    [WEBVIEW, false, 'embedded'],
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36', false, 'generic'],
  ])('%s (standalone %s) → %s', (userAgent, standalone, kind) => {
    expect(micGuideKind(userAgent, standalone)).toBe(kind)
  })

  it('во встроенном окне — копирование адреса, в остальных нет', () => {
    expect(micGuide(YA_APP, false).copyAddress).toBe(true)
    expect(micGuide(SAFARI_IOS, false).copyAddress).toBe(false)
    expect(micGuide(SAFARI_IOS, false).steps).toHaveLength(3)
  })
})

describe('проверка разрешения без запроса', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('отдаёт состояние, а где браузер не умеет, null', async () => {
    vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'denied' }) } })
    expect(await queryMicPermission()).toBe('denied')
    vi.stubGlobal('navigator', {
      permissions: {
        query: async () => {
          throw new TypeError('microphone')
        },
      },
    })
    expect(await queryMicPermission()).toBeNull()
  })

  it('сообщает о смене и перестаёт после отписки', async () => {
    const listeners: Array<() => void> = []
    const status = {
      state: 'denied',
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
    }
    vi.stubGlobal('navigator', { permissions: { query: async () => status } })
    const seen: string[] = []
    const stop = watchMicPermission((state) => seen.push(state))
    await Promise.resolve()
    await Promise.resolve()
    status.state = 'granted'
    for (const fn of listeners) fn()
    expect(seen).toEqual(['granted'])
    stop()
    expect(listeners).toHaveLength(0)
  })
})
