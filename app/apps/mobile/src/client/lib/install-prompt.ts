import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { isStandalone, isWebBuild } from './platform'

/**
 * `beforeinstallprompt` fires once, at an arbitrary moment after load, so the listener is
 * installed at module level rather than inside a component. iOS Safari does not support the
 * event at all: there InstallBanner shows the "Share -> Add to Home Screen" hint instead.
 *
 * A browser tab cannot ask "is this app installed?": once it is, Chrome stops sending
 * `beforeinstallprompt`, which looks the same as a browser that never sends it. So the install is
 * remembered in localStorage, which the tab and the installed window share on desktop and Android:
 * it is written on `appinstalled` and whenever the app runs standalone, and dropped when the browser
 * offers the install again (the app was uninstalled).
 */

const INSTALLED_KEY = 'ryadom.install.installedAt'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
let listeners: Array<() => void> = []

function notify(): void {
  listeners.forEach((fn) => fn())
}

function hasInstalledMark(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) !== null
  } catch {
    return false
  }
}

function setInstalledMark(installed: boolean): void {
  try {
    if (installed) localStorage.setItem(INSTALLED_KEY, String(Date.now()))
    else localStorage.removeItem(INSTALLED_KEY)
  } catch {
    // Storage is unavailable, so a tab opened later cannot tell that the app is installed.
  }
}

if (isWebBuild() && typeof window !== 'undefined') {
  if (isStandalone()) setInstalledMark(true)
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    // The browser offers the install only while the app is not installed, so a mark is stale now.
    setInstalledMark(false)
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    setInstalledMark(true)
    notify()
  })
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null
}

/** The app runs installed, or this browser is known to have it installed. */
export function isAppInstalled(): boolean {
  return isStandalone() || hasInstalledMark()
}

export function onInstallPromptChange(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((listener) => listener !== fn)
  }
}

/** `false` when the prompt is unavailable or the person declined. */
export async function triggerInstallPrompt(): Promise<boolean> {
  const prompt = deferredPrompt
  if (!prompt) return false
  await prompt.prompt()
  const choice = await prompt.userChoice
  deferredPrompt = null
  track(AnalyticsEvent.InstallPrompt, { action: choice.outcome })
  notify()
  return choice.outcome === 'accepted'
}
