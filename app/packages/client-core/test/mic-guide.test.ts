import { afterEach, describe, expect, it, vi } from 'vitest'
import { micGuide, micGuideKind, type MicPlace } from '../src/voice/mic-guide'
import { queryMicPermission, watchMicPermission } from '../src/voice/mic-permission'

// `openspec/changes/add-mic-permission-guide`, «Микрофон или голос недоступны»: the steps depend on the place.
const UA = {
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  yandexIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 YaBrowser/24.10.0 Mobile/15E148 Safari/605.1',
  yandexAndroid:
    'Mozilla/5.0 (Linux; arm_64; Android 14) AppleWebKit/537.36 Chrome/128.0.0.0 YaBrowser/24.10.0 Mobile Safari/537.36',
  yaApp: 'Mozilla/5.0 (Linux; arm_64; Android 14) AppleWebKit/537.36 Chrome/128.0.0.0 YaSearchApp/24.80 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  opera:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 OPR/85.0.0.0',
  webview: 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeDesktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  firefoxDesktop: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
}

const place = (userAgent: string, extra: Partial<MicPlace> = {}): MicPlace => ({
  userAgent,
  standalone: false,
  native: false,
  ...extra,
})

describe('micGuideKind', () => {
  it.each([
    ['Chrome на Android', place(UA.chromeAndroid), 'chrome-android'],
    ['Яндекс Браузер на Android', place(UA.yandexAndroid), 'yandex-android'],
    ['Samsung Internet', place(UA.samsung), 'samsung'],
    ['Firefox на Android', place(UA.firefoxAndroid), 'firefox-android'],
    ['Opera на Android', place(UA.opera), 'android-other'],
    ['Safari на iPhone', place(UA.safariIos), 'safari-ios'],
    ['iPad с UA Mac и касанием', place(UA.ipadSafari, { touch: true }), 'safari-ios'],
    ['Chrome на iPhone', place(UA.chromeIos), 'browser-ios'],
    ['Яндекс Браузер на iPhone', place(UA.yandexIos), 'browser-ios'],
    ['окно приложения Яндекса', place(UA.yaApp), 'embedded'],
    ['WebView без оболочки', place(UA.webview), 'embedded'],
    ['PWA на Android', place(UA.chromeAndroid, { standalone: true }), 'pwa-android'],
    ['PWA на iPhone', place(UA.safariIos, { standalone: true }), 'pwa-ios'],
    // The store build's WebView looks like an embedded browser, but the app has its own switch in the settings.
    ['сборка для Android', place(UA.webview, { native: true }), 'native-android'],
    ['сборка для iOS', place(UA.safariIos, { native: true }), 'native-ios'],
    ['Chrome на компьютере', place(UA.chromeDesktop), 'chrome-desktop'],
    ['Firefox на компьютере', place(UA.firefoxDesktop), 'firefox-desktop'],
    ['Safari на Mac', place(UA.safariMac), 'safari-mac'],
  ])('%s → %s', (_name, where, kind) => {
    expect(micGuideKind(where)).toBe(kind)
  })

  it('шаги называют только то, что есть на устройстве', () => {
    const text = (where: MicPlace) => micGuide(where).steps.join(' ')
    expect(text(place(UA.safariIos))).toContain('«Аа»')
    expect(text(place(UA.chromeAndroid))).not.toContain('«Аа»')
    expect(text(place(UA.chromeAndroid))).toContain('Chrome')
    expect(text(place(UA.chromeIos))).toContain('Chrome')
    expect(text(place(UA.chromeIos))).not.toContain('«Аа»')
    expect(text(place(UA.yandexIos))).toContain('Яндекс Браузер')
    expect(text(place(UA.safariIos, { native: true }))).toContain('Настройки')
    expect(text(place(UA.chromeDesktop))).not.toContain('Приложения')
  })

  it('во встроенном окне — копирование адреса, в остальных нет', () => {
    expect(micGuide(place(UA.yaApp)).copyAddress).toBe(true)
    expect(micGuide(place(UA.safariIos)).copyAddress).toBe(false)
    expect(micGuide(place(UA.safariIos)).steps).toHaveLength(3)
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
