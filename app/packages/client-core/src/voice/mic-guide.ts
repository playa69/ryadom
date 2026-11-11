/**
 * Step-by-step help for a person whose microphone was refused: the way to turn it back on depends on the
 * browser and the system, and a step that names a menu the device does not have is worse than none.
 * `openspec/changes/add-mic-permission-guide`, «Микрофон или голос недоступны».
 */

export type MicGuideKind =
  | 'embedded'
  | 'native-android'
  | 'native-ios'
  | 'pwa-android'
  | 'pwa-ios'
  | 'safari-ios'
  | 'browser-ios'
  | 'chrome-android'
  | 'yandex-android'
  | 'firefox-android'
  | 'samsung'
  | 'android-other'
  | 'chrome-desktop'
  | 'firefox-desktop'
  | 'safari-mac'
  | 'generic'

export interface MicGuide {
  kind: MicGuideKind
  title: string
  intro: string
  steps: string[]
  /** The page cannot fix it from here: the person has to open it in the system browser. */
  copyAddress: boolean
}

/** Where the page runs: an installed web app (`standalone`) or a store build (`native`) have their own switch in the system. */
export interface MicPlace {
  userAgent: string
  standalone: boolean
  native: boolean
  /** The browser says it is a touch device (iPadOS announces itself as a Mac). */
  touch?: boolean
}

const EMBEDDED = /YaSearchApp|YaApp_|Telegram|VKAndroidApp|VKApp|Instagram|FBAN|FBAV|; wv\)/i

function isIos({ userAgent, touch }: MicPlace): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touch === true)
}

export function micGuideKind(place: MicPlace): MicGuideKind {
  const ua = place.userAgent
  const ios = isIos(place)
  // A store build's WebView looks like an embedded browser, but the app has its own switch in the settings.
  if (place.native) return ios ? 'native-ios' : 'native-android'
  if (place.standalone) return ios ? 'pwa-ios' : 'pwa-android'
  if (EMBEDDED.test(ua)) return 'embedded'
  if (ios) {
    // Every browser on iOS is Safari underneath; only Safari itself has the «Аа» menu, the others are switched in the Settings app.
    return /CriOS|FxiOS|YaBrowser|EdgiOS|OPT\//.test(ua) ? 'browser-ios' : 'safari-ios'
  }
  if (/Android/.test(ua)) {
    if (/YaBrowser|YaSearchBrowser/.test(ua)) return 'yandex-android'
    if (/SamsungBrowser/.test(ua)) return 'samsung'
    if (/Firefox\//.test(ua)) return 'firefox-android'
    if (/OPR\/|EdgA|Opera|UCBrowser|MiuiBrowser/.test(ua)) return 'android-other'
    if (/Chrome\//.test(ua)) return 'chrome-android'
    return 'android-other'
  }
  if (/Firefox\//.test(ua)) return 'firefox-desktop'
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|YaBrowser/.test(ua)) return 'safari-mac'
  if (/Chrome\/|Chromium\//.test(ua)) return 'chrome-desktop'
  return 'generic'
}

/** The name of the browser on iOS, for the line in the Settings app. */
function iosBrowserName(userAgent: string): string {
  if (/CriOS/.test(userAgent)) return 'Chrome'
  if (/FxiOS/.test(userAgent)) return 'Firefox'
  if (/YaBrowser/.test(userAgent)) return 'Яндекс Браузер'
  if (/EdgiOS/.test(userAgent)) return 'Edge'
  return 'браузер'
}

const OFF = 'Микрофон выключен'
const BROWSER_ASKS_NO_MORE = 'Браузер больше не спрашивает сам. Включи микрофон для Рядом:'

export function micGuide(place: MicPlace): MicGuide {
  const kind = micGuideKind(place)
  const guide = (title: string, intro: string, steps: string[], copyAddress = false): MicGuide => ({
    kind,
    title,
    intro,
    steps,
    copyAddress,
  })
  switch (kind) {
    case 'embedded':
      return guide(
        'Здесь микрофон не включить',
        'В окне другого приложения микрофон часто заблокирован. Открой Рядом в Chrome или Safari:',
        ['Скопируй адрес — кнопка ниже', 'Открой Chrome или Safari и вставь адрес в строку'],
        true,
      )
    case 'native-android':
    case 'pwa-android':
      return guide(OFF, 'Приложению Рядом не дали доступ к микрофону:', [
        'Открой настройки телефона → «Приложения» → Рядом',
        'Выбери «Разрешения» → «Микрофон»',
        'Поставь «Разрешить» и вернись в Рядом',
      ])
    case 'native-ios':
      return guide(OFF, 'Приложению Рядом не дали доступ к микрофону:', [
        'Открой «Настройки» на iPhone и найди в списке Рядом',
        'Включи переключатель «Микрофон»',
        'Вернись в Рядом',
      ])
    case 'pwa-ios':
      return guide(OFF, 'Рядом на экране «Домой» открывается через Safari, микрофон включается в его настройках:', [
        'Открой «Настройки» на iPhone → «Приложения» → Safari',
        'Найди «Микрофон» и поставь «Спрашивать» или «Разрешить»',
        'Вернись в Рядом',
      ])
    case 'safari-ios':
      return guide(OFF, 'Включи его для сайта в Safari:', [
        'Нажми «Аа» в левой части адресной строки',
        'Выбери «Настройки веб-сайта»',
        'Поставь «Микрофон» → «Разрешить»',
      ])
    case 'browser-ios':
      return guide(OFF, `Микрофон для ${iosBrowserName(place.userAgent)} включается в настройках iPhone:`, [
        `Открой «Настройки» на iPhone и найди в списке ${iosBrowserName(place.userAgent)}`,
        'Включи переключатель «Микрофон»',
        'Вернись в Рядом',
      ])
    case 'yandex-android':
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Нажми на значок слева от адреса',
        'Открой «Настройки сайта» → «Микрофон»',
        'Поставь «Разрешить»',
      ])
    case 'samsung':
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Нажми на значок замка слева от адреса',
        'Открой «Разрешения» и включи «Микрофон»',
        'Если пункта нет: меню ≡ → «Настройки» → «Сайты и загрузки» → «Разрешения сайтов» → «Микрофон»',
      ])
    case 'firefox-android':
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Нажми на значок замка слева от адреса',
        'Выбери «Изменить разрешения сайта»',
        'Поставь «Микрофон» → «Разрешить»',
      ])
    case 'chrome-android':
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Нажми на значок слева от адреса (замок или «настройки»)',
        'Выбери «Разрешения» и включи «Микрофон»',
        'Если микрофон не включается: настройки телефона → «Приложения» → Chrome → «Разрешения» → «Микрофон»',
      ])
    case 'android-other':
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Открой меню браузера → «Настройки» → «Настройки сайтов» → «Микрофон»',
        'Найди Рядом и поставь «Разрешить»',
        'Если браузер совсем не просит доступ: настройки телефона → «Приложения» → браузер → «Разрешения» → «Микрофон»',
      ])
    case 'chrome-desktop':
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Нажми на значок слева от адреса',
        'Включи «Микрофон»',
        'Если браузер предложит перезагрузить страницу — перезагрузи',
      ])
    case 'firefox-desktop':
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Нажми на значок слева от адреса',
        'В «Разрешениях» убери блокировку у «Использовать микрофон»',
        'Перезагрузи страницу',
      ])
    case 'safari-mac':
      return guide(OFF, 'Включи микрофон для сайта в Safari:', [
        'В меню выбери Safari → «Настройки для этого веб-сайта»',
        'Поставь «Микрофон» → «Разрешить»',
        'Если и так включено: «Системные настройки» → «Конфиденциальность и безопасность» → «Микрофон» → включи Safari',
      ])
    default:
      return guide(OFF, BROWSER_ASKS_NO_MORE, [
        'Нажми на значок слева от адреса',
        'Открой настройки сайта и разреши «Микрофон»',
        'Перезагрузи страницу, если браузер попросит',
      ])
  }
}
