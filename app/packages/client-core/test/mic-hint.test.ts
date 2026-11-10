import { describe, expect, it } from 'vitest'
import {
  MIC_DENIED_EMBEDDED_TEXT,
  MIC_DENIED_IOS_TEXT,
  MIC_DENIED_TEXT,
  micDeniedText,
} from '../src/voice/mic-hint'

// openspec/changes/mic-denied-hint-by-browser, «Микрофон или голос недоступны»
describe('micDeniedText', () => {
  it('в окне Яндекса и других встроенных браузеров советует открыть системный браузер', () => {
    const yandexSearch =
      'Mozilla/5.0 (Linux; arm_64; Android 14; TECNO CK6n) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.133 YaSearchBrowser/24.66.1 BroPP/1.0 YaSearchApp/24.66.1 webOmni SA/3 Mobile Safari/537.36'
    const webView =
      'Mozilla/5.0 (Linux; Android 13; 2305EPCC4G Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36'
    expect(micDeniedText(yandexSearch)).toBe(MIC_DENIED_EMBEDDED_TEXT)
    expect(micDeniedText(webView)).toBe(MIC_DENIED_EMBEDDED_TEXT)
  })

  it('в Safari на iPhone указывает, где включить микрофон', () => {
    const safari =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1'
    expect(micDeniedText(safari)).toBe(MIC_DENIED_IOS_TEXT)
  })

  it('в остальных местах оставляет прежний текст', () => {
    const chrome =
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
    const yandexIos =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 YaBrowser/26.10.4.501.10 Safari/604.1'
    expect(micDeniedText(chrome)).toBe(MIC_DENIED_TEXT)
    expect(micDeniedText(yandexIos)).toBe(MIC_DENIED_TEXT)
    expect(micDeniedText('')).toBe(MIC_DENIED_TEXT)
  })
})
