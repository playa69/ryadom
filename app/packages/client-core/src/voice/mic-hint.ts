export const MIC_DENIED_TEXT = 'Микрофон не разрешён. Разреши его в настройках — или пиши текстом.'

/**
 * Embedded browsers of other apps (the Yandex search app, Telegram, VK, social networks) usually refuse the
 * microphone without ever asking, and their settings have no switch for it: the person is better off
 * opening the page in the system browser.
 */
const EMBEDDED_BROWSER =
  /YaSearchApp|YaSearchBrowser|YaApp_|Telegram|VKAndroidApp|VKApp|Instagram|FBAN|FBAV|; wv\)/i

/** Browser tab only: the Capacitor shells report no marker, and the setting they need is the system one. */
export const MIC_DENIED_EMBEDDED_TEXT =
  'Микрофон не разрешён: в этом окне его часто блокируют. Открой Рядом в Chrome или Safari — или пиши текстом.'

export const MIC_DENIED_IOS_TEXT =
  'Микрофон не разрешён. Включи его для сайта в настройках Safari (значок «Аа» в адресной строке) — или пиши текстом.'

/** What to tell a person whose microphone was refused: the advice depends on where the page is open. */
export function micDeniedText(userAgent: string): string {
  if (EMBEDDED_BROWSER.test(userAgent)) return MIC_DENIED_EMBEDDED_TEXT
  if (
    /iPhone|iPad/.test(userAgent) &&
    /Safari\//.test(userAgent) &&
    !/CriOS|YaBrowser|FxiOS/.test(userAgent)
  ) {
    return MIC_DENIED_IOS_TEXT
  }
  return MIC_DENIED_TEXT
}
