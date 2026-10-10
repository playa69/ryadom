import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Icon } from 'framework7-react'
import { useEffect, useReducer, useRef, useState } from 'react'
import { canPromptInstall, isAppInstalled, onInstallPromptChange, triggerInstallPrompt } from '../lib/install-prompt'
import { isInAppBrowser, isIos } from '../lib/platform'

/**
 * PWA install banner, web build only, and not once the app is installed: neither in its own window
 * nor in a browser tab of a browser that has it installed. Hidden for 14 days once dismissed:
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
  // The install state lives outside React (install-prompt.ts); a change only asks for a re-render.
  const [, refresh] = useReducer((tick: number) => tick + 1, 0)

  useEffect(() => onInstallPromptChange(refresh), [])

  const visible = !dismissed && !isAppInstalled()
  const installable = canPromptInstall()

  // Once per page load, when the banner first appears. The iOS hint is told apart: there is no install button there.
  const shown = useRef(false)
  useEffect(() => {
    if (!visible || shown.current) return
    shown.current = true
    const iosHint = !installable && !isInAppBrowser() && isIos()
    track(AnalyticsEvent.InstallPrompt, { action: iosHint ? 'ios_instructions' : 'shown' })
  }, [visible, installable])

  if (!visible) return null

  const close = () => {
    track(AnalyticsEvent.InstallPrompt, { action: 'dismissed' })
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
