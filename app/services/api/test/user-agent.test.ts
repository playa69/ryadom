/**
 * Names of the browser and the system out of `User-Agent`, for the list of sessions. The agents are
 * real ones: what matters is that Edge, Opera and the rest are not taken for Chrome, and an iPhone
 * for a Mac.
 */
import { describe, expect, it } from 'vitest'
import { describeUserAgent } from '../src/lib/user-agent'

describe('имена браузера и системы по User-Agent', () => {
  it.each([
    [
      'Chrome на Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'Windows' },
    ],
    [
      'Edge: в агенте есть и Chrome, и Safari',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      { browser: 'Edge', os: 'Windows' },
    ],
    [
      'Opera',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0',
      { browser: 'Opera', os: 'Windows' },
    ],
    [
      'Яндекс Браузер',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 YaBrowser/24.6.0.0 Safari/537.36',
      { browser: 'Яндекс Браузер', os: 'Windows' },
    ],
    [
      'Firefox на Linux',
      'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      { browser: 'Firefox', os: 'Linux' },
    ],
    [
      'Safari на Mac',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      { browser: 'Safari', os: 'macOS' },
    ],
    [
      'Safari на iPhone: «like Mac OS X» не делает его маком',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS' },
    ],
    [
      'Chrome на iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
      { browser: 'Chrome', os: 'iOS' },
    ],
    [
      'Chrome на Android: «Linux» в агенте не делает его десктопным Linux',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android' },
    ],
    [
      'Samsung Internet',
      'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      { browser: 'Samsung Internet', os: 'Android' },
    ],
    [
      'WebView приложения на Android',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android' },
    ],
  ])('%s', (_name, userAgent, expected) => {
    expect(describeUserAgent(userAgent)).toEqual(expected)
  })

  it('пустой и незнакомый агент — без имён, а не догадка', () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null })
    expect(describeUserAgent('')).toEqual({ browser: null, os: null })
    expect(describeUserAgent('curl/8.5.0')).toEqual({ browser: null, os: null })
  })
})
