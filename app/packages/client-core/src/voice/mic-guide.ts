/**
 * Step-by-step help for a person whose microphone was refused: the way to turn it back on depends on
 * where the page is open. Prototype for PROTEUS-284 (`openspec/changes/add-mic-permission-guide`).
 */

export type MicGuideKind = 'chrome-android' | 'safari-ios' | 'yandex' | 'embedded' | 'pwa' | 'generic'

export interface MicGuide {
  kind: MicGuideKind
  title: string
  intro: string
  steps: string[]
  /** The page cannot fix it from here: the person has to open it in the system browser. */
  copyAddress: boolean
}

const EMBEDDED = /YaSearchApp|YaApp_|Telegram|VKAndroidApp|VKApp|Instagram|FBAN|FBAV|; wv\)/i

export function micGuideKind(userAgent: string, standalone: boolean): MicGuideKind {
  // An installed app (a PWA or a store build, whose WebView looks like an embedded browser) has its own switch in the system settings.
  if (standalone) return 'pwa'
  if (EMBEDDED.test(userAgent)) return 'embedded'
  if (/iPhone|iPad/.test(userAgent) && /Safari\//.test(userAgent) && !/CriOS|YaBrowser|FxiOS/.test(userAgent)) {
    return 'safari-ios'
  }
  if (/YaBrowser|YaSearchBrowser/.test(userAgent)) return 'yandex'
  if (/Android/.test(userAgent) && /Chrome\//.test(userAgent)) return 'chrome-android'
  return 'generic'
}

export function micGuide(userAgent: string, standalone: boolean): MicGuide {
  const kind = micGuideKind(userAgent, standalone)
  switch (kind) {
    case 'embedded':
      return {
        kind,
        title: 'Здесь микрофон не включить',
        intro: 'В окне другого приложения микрофон часто заблокирован. Открой Рядом в Chrome или Safari:',
        steps: ['Скопируй адрес — кнопка ниже', 'Открой Chrome или Safari и вставь адрес в строку'],
        copyAddress: true,
      }
    case 'pwa':
      return {
        kind,
        title: 'Микрофон выключен',
        intro: 'Приложению Рядом не дали доступ к микрофону:',
        steps: [
          'Открой настройки телефона → «Приложения» → Рядом',
          'Выбери «Разрешения» → «Микрофон»',
          'Вернись и нажми «Попробовать снова»',
        ],
        copyAddress: false,
      }
    case 'safari-ios':
      return {
        kind,
        title: 'Микрофон выключен',
        intro: 'Включи его для сайта в Safari:',
        steps: ['Нажми «Аа» в адресной строке', 'Выбери «Настройки веб-сайта»', 'Поставь «Микрофон» → «Разрешить»'],
        copyAddress: false,
      }
    case 'yandex':
      return {
        kind,
        title: 'Микрофон выключен',
        intro: 'Браузер больше не спрашивает сам. Включи микрофон для Рядом:',
        steps: ['Нажми на значок слева от адреса', 'Открой «Настройки сайта»', 'Поставь «Микрофон» → «Разрешить»'],
        copyAddress: false,
      }
    case 'chrome-android':
      return {
        kind,
        title: 'Микрофон выключен',
        intro: 'Браузер больше не спрашивает сам. Включи микрофон для Рядом:',
        steps: ['Нажми на замок слева от адреса', 'Выбери «Разрешения»', 'Включи «Микрофон»'],
        copyAddress: false,
      }
    default:
      return {
        kind,
        title: 'Микрофон выключен',
        intro: 'Браузер больше не спрашивает сам. Включи микрофон для Рядом:',
        steps: ['Нажми на значок слева от адреса', 'Открой настройки сайта', 'Разреши «Микрофон»'],
        copyAddress: false,
      }
  }
}
