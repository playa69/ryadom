import { Icon } from 'framework7-react'
import { useRef, useSyncExternalStore, type PointerEvent } from 'react'
import {
  msToNextThemeBoundary,
  readThemeOverride,
  resolveTheme,
  saveThemeOverride,
  type Theme,
} from '@ryadom/client-core/theme'
import { isNative } from '../lib/platform'

/*
 * Day/night theme of the PWA and the Telegram Mini App: the shared schedule (light 07:00–21:59 local)
 * until a manual choice, which is then stored on the device and wins over the schedule. The native
 * shell stays dark: it gets no switch and no schedule. The very first theme is chosen by the inline
 * script in index.html before the first paint; this module picks it up from the root attribute, so
 * the two never disagree.
 */

/** Whether this runtime follows the schedule and offers the choice at all. */
const scheduled = !isNative()

let override: Theme | null = scheduled ? readThemeOverride(window.localStorage) : null
let current: Theme =
  scheduled && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * The window chrome color follows the palette itself, so it cannot drift from the tokens; the
 * constants only cover the boot before the stylesheets arrive (mirrored in index.html).
 */
function themeColorFor(theme: Theme): string {
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--ryadom-paper').trim()
  return paper || (theme === 'light' ? '#f4f6fd' : '#00051a')
}

/**
 * Applies the theme to the document: the light palette is `data-theme` on the root, Framework7's
 * dark chrome is its `dark` class there, and the browser chrome follows the meta tags.
 */
export function applyTheme(theme: Theme): void {
  current = theme
  const root = document.documentElement
  if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
  const themeColor = document.querySelector('meta[name="theme-color"]')
  if (themeColor) themeColor.setAttribute('content', themeColorFor(theme))
  const colorScheme = document.querySelector('meta[name="color-scheme"]')
  if (colorScheme) colorScheme.setAttribute('content', theme)
  emit()
}

/** The theme for this moment: the manual choice while there is one, the schedule otherwise. */
export function syncTheme(now: Date = new Date()): void {
  if (!scheduled) return
  applyTheme(resolveTheme(now, override))
}

/** The manual choice from the switch: applied at once, stored on this device; no request anywhere. */
export function chooseTheme(theme: Theme): void {
  if (!scheduled) return
  override = theme
  saveThemeOverride(window.localStorage, theme)
  applyTheme(theme)
}

/**
 * The schedule of an open client: re-resolved on every 07:00/22:00 boundary and on coming back to
 * the tab. A manual choice survives both (resolveTheme prefers it), so the timer is harmless then.
 */
export function initThemeSchedule(): () => void {
  if (!scheduled) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const recheck = () => {
    syncTheme()
    timer = setTimeout(recheck, msToNextThemeBoundary(new Date()))
  }
  recheck()
  const onVisible = () => {
    if (document.visibilityState === 'visible') recheck()
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current)
}

/** A horizontal drag across the pill counts once it clearly leaves a tap. */
const SWIPE_PX = 24

/**
 * The theme a horizontal swipe asks for: right is night, left is day. Below the swipe threshold the
 * gesture is still a tap, so the pointer sequence resolves to nothing here and to a toggle in click.
 */
export function swipeTheme(dx: number): Theme | null {
  if (Math.abs(dx) < SWIPE_PX) return null
  return dx > 0 ? 'dark' : 'light'
}

/**
 * The compact day/night switch of the first and the home screen. The visual pill is small; the
 * button itself is the 44×44 hit area. A tap, a horizontal swipe across the pill and the keyboard
 * (it is a button) all switch. The native shell never renders it.
 */
export default function ThemeSwitch({
  className,
  slot,
}: {
  className?: string
  /** Read by Framework7's Page (`fixed` escapes the scroll area), not here. */
  slot?: string
}) {
  const theme = useTheme()
  const swipeFrom = useRef<number | null>(null)
  /** A swipe ends in pointerup but still produces a click, which must not toggle the theme back. */
  const swiped = useRef(false)
  if (!scheduled) return null

  const dark = theme === 'dark'

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    // The pill is small and the finger easily slides off the 44px button; capture keeps pointerup
    // (and the click after it) addressed to the button instead of losing them outside.
    event.currentTarget.setPointerCapture(event.pointerId)
    swipeFrom.current = event.clientX
    swiped.current = false
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    if (swipeFrom.current === null) return
    const theme = swipeTheme(event.clientX - swipeFrom.current)
    swipeFrom.current = null
    if (theme === null) return
    swiped.current = true
    chooseTheme(theme)
  }

  function onClick() {
    if (swiped.current) {
      swiped.current = false
      return
    }
    chooseTheme(dark ? 'light' : 'dark')
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={dark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      className={className ? `rd-theme-switch ${className}` : 'rd-theme-switch'}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      data-testid="theme-switch"
    >
      <span
        className={`rd-theme-switch-track${dark ? ' rd-theme-switch-track--dark' : ''}`}
        aria-hidden="true"
      >
        <span className="rd-theme-switch-knob">
          <Icon f7={dark ? 'moon_fill' : 'sun_max_fill'} size={13} className="rd-theme-switch-icon" />
        </span>
      </span>
    </button>
  )
}
