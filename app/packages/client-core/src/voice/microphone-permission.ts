export const MIC_DENIED_TEXT = 'Микрофон не разрешён. Разреши его в настройках — или пиши текстом.'
export const MIC_NOT_FOUND_TEXT = 'Микрофон не найден. Проверь подключение или пиши текстом.'
export const MIC_HELP_TITLE = 'Разреши доступ к микрофону'
export const MIC_HELP_RETRY = 'Попробовать снова'
export const MIC_HELP_TEXT = 'Продолжить текстом'

export interface MicrophoneBrowser {
  userAgent: string
  maxTouchPoints: number
  standalone: boolean
}

/** Use local browser hints only to pick copy. Standalone windows have no address bar. */
export function microphonePermissionSteps({
  userAgent: ua,
  maxTouchPoints,
  standalone,
}: MicrophoneBrowser): string[] {
  const android = /Android/i.test(ua)
  const appleMobile = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
  const embedded = /; wv\)|Telegram|FBAN|FBAV|Instagram/i.test(ua)
  const edge = /Edg\//.test(ua) && !android && !appleMobile
  const chrome = /(?:Chrome|CriOS)\//.test(ua) && !/Edg|OPR\/|SamsungBrowser\/|YaBrowser\//.test(ua)
  const safari = /Safari\//.test(ua) && !/(?:Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)\//.test(ua)
  if (!embedded && standalone && chrome && android) {
    return [
      'Открой Chrome → «Настройки» → «Настройки сайтов» → «Микрофон».',
      'Выбери сайт «Рядом» среди заблокированных и разреши доступ. Если нужно, проверь разрешение для Chrome в настройках телефона.',
    ]
  }
  if (!embedded && standalone && (chrome || edge) && !appleMobile && !android) {
    return [
      'Открой меню ⋮ в правом верхнем углу окна «Рядом».',
      'Выбери «Сведения о приложении» → «Настройки» и разреши микрофон.',
    ]
  }
  if (!embedded && !standalone) {
    if (chrome && android) {
      return [
        'Нажми значок рядом с адресом → «Разрешения» → «Микрофон».',
        'Выбери «Разрешить». Если доступ выключен для Chrome, проверь его разрешения в настройках телефона.',
      ]
    }
    if (chrome && appleMobile) {
      return [
        'Нажми значок микрофона рядом с адресом и включи доступ.',
        'Если доступ выключен для Chrome, открой «Настройки» → «Приложения» → Chrome и включи микрофон.',
      ]
    }
    if (safari && appleMobile) {
      return [
        'Открой меню страницы рядом с адресом → «Настройки сайта».',
        'Выбери «Микрофон» → «Разрешить» для этого сайта.',
      ]
    }
    if (safari && /Macintosh/.test(ua)) {
      return [
        'Открой Safari → «Настройки» → «Веб-сайты» → «Микрофон».',
        'Выбери «Разрешить» для сайта «Рядом».',
      ]
    }
    if (chrome || edge) {
      return [
        'Нажми значок «Сведения о сайте» рядом с адресом.',
        'В разрешениях сайта выбери «Разрешить» для микрофона.',
      ]
    }
    if (/Firefox\//.test(ua) && !android && !appleMobile) {
      return [
        'Нажми значок разрешений рядом с адресом и убери блокировку микрофона.',
        'Повтори попытку и выбери «Разрешить», когда Firefox запросит доступ.',
      ]
    }
  }
  return [
    'Проверь, разрешён ли микрофон для «Рядом» в настройках браузера или приложения.',
    'Если доступ выключен для самого браузера, проверь его разрешения в настройках устройства.',
  ]
}

export function currentMicrophonePermissionSteps(): string[] {
  return microphonePermissionSteps({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  })
}

export type MicrophoneRecovery = { stage: 'denied' } | { stage: 'recovered'; elapsed_ms: number }

/** One pair per open dialog screen. Count only a capture that the screen accepts and starts using. */
export function createMicrophoneRecovery(report: (event: MicrophoneRecovery) => void) {
  let deniedAt: number | undefined
  let opened = false
  return {
    denied(now: number) {
      if (deniedAt !== undefined || opened) return
      deniedAt = now
      report({ stage: 'denied' })
    },
    opened(now: number) {
      if (opened) return
      opened = true
      if (deniedAt === undefined) return
      report({ stage: 'recovered', elapsed_ms: Math.max(0, Math.round(now - deniedAt)) })
    },
  }
}
