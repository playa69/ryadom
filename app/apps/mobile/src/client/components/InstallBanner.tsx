import { Icon } from 'framework7-react'
import { useEffect, useState } from 'react'
import { canPromptInstall, onInstallPromptChange, triggerInstallPrompt } from '../lib/install-prompt'
import { isInAppBrowser, isIos, isStandalone } from '../lib/platform'

/**
 * PWA install banner, web build outside standalone mode only. Hidden for 14 days once dismissed:
 * within two weeks a person either installs the app or decides not to.
 */

const DISMISSED_KEY = 'ryadom.install.dismissedAt'
const DISMISS_DAYS = 14

function isDismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return false
    return Date.now() - Number(raw) < DISMISS_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

export default function InstallBanner() {
  const [dismissed, setDismissed] = useState(isDismissedRecently)
  const [installable, setInstallable] = useState(canPromptInstall)

  useEffect(() => onInstallPromptChange(() => setInstallable(canPromptInstall())), [])

  if (dismissed || isStandalone()) return null

  const close = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    } catch {
      // Storage is unavailable, so the banner returns on the next load. That is acceptable.
    }
    setDismissed(true)
  }

  const text = installable
    ? 'Установи «Рядом» на телефон — открывается сразу, без браузера'
    : isInAppBrowser()
      ? `Открой «Рядом» в ${isIos() ? 'Safari' : 'браузере'}, чтобы поставить на телефон`
      : isIos()
        ? 'Нажми «Поделиться» и выбери «На экран «Домой»»'
        : 'Открой меню браузера и выбери «Установить приложение»'

  return (
    <div className="rd-banner rd-banner--bottom" role="status">
      <Icon f7="arrow_down_circle_fill" size={20} />
      <span className="rd-banner-text">{text}</span>
      {installable && (
        <button type="button" className="rd-banner-action" onClick={() => void triggerInstallPrompt()}>
          Установить
        </button>
      )}
      <button type="button" className="rd-banner-close" aria-label="Скрыть" onClick={close}>
        <Icon f7="xmark" size={16} />
      </button>
    </div>
  )
}
