import { App } from '@capacitor/app'
import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { f7, f7ready } from 'framework7-react'
import { TAB_IDS } from './nav'
import { isNative, isWebBuild } from './platform'
import { isTelegramMiniApp, telegramWebApp } from './telegram'

/** Behaviour a native app is expected to have that a WebView does not provide by itself. */

const MAIN_TAB = `#${TAB_IDS.home}`

/** Closes the topmost open Framework7 modal, if any. */
function closeTopModal(): boolean {
  const selectors = [
    '.dialog.modal-in',
    '.actions-modal.modal-in',
    '.sheet-modal.modal-in',
    '.popup.modal-in',
    '.popover.modal-in',
  ]
  for (const selector of selectors) {
    const el = document.querySelector(selector)
    if (!el) continue
    if (selector.startsWith('.dialog')) f7.dialog.close(el as HTMLElement)
    else if (selector.startsWith('.actions')) f7.actions.close(el as HTMLElement)
    else if (selector.startsWith('.sheet')) f7.sheet.close(el as HTMLElement)
    else if (selector.startsWith('.popup')) f7.popup.close(el as HTMLElement)
    else f7.popover.close(el as HTMLElement)
    return true
  }
  return false
}

const MODAL_SELECTOR =
  '.dialog.modal-in, .actions-modal.modal-in, .sheet-modal.modal-in, .popup.modal-in, .popover.modal-in'

/** Whether "back" has somewhere to go inside the app: an open modal, a step in the tab, or another tab. */
function canGoBack(): boolean {
  if (document.querySelector(MODAL_SELECTOR)) return true
  const view = f7.views.current
  if (view && view.router.history.length > 1) return true
  const activeTab = document.querySelector('.views.tabs > .view.tab-active')
  return Boolean(activeTab && `#${activeTab.id}` !== MAIN_TAB && document.querySelector(MAIN_TAB))
}

/**
 * One order for "back" everywhere: modal, then a step back inside the tab, then the home tab.
 * `false` means there is nowhere left to go and the caller decides (Android minimises, the web
 * lets the browser actually leave).
 */
function handleBackStep(): boolean {
  if (closeTopModal()) return true
  const view = f7.views.current
  if (view && view.router.history.length > 1) {
    view.router.back()
    return true
  }
  const activeTab = document.querySelector('.views.tabs > .view.tab-active')
  if (activeTab && `#${activeTab.id}` !== MAIN_TAB && document.querySelector(MAIN_TAB)) {
    f7.tab.show(MAIN_TAB)
    return true
  }
  return false
}

/**
 * Android hardware back. Without a handler Capacitor walks browser history, which Framework7
 * does not use, so the app closed from any screen.
 */
export function initBackButton(): () => void {
  if (!isNative()) return () => {}
  let remove: (() => void) | null = null
  let removed = false

  void App.addListener('backButton', () => {
    // The "update required" screen cannot be dismissed: back just minimises.
    if (document.querySelector('.rd-blocking')) {
      void App.minimizeApp()
      return
    }
    if (!handleBackStep()) void App.minimizeApp()
  }).then((handle) => {
    if (removed) void handle.remove()
    else remove = () => void handle.remove()
  })

  return () => {
    removed = true
    remove?.()
  }
}

/**
 * The same for the web build. Framework7 routes in memory here too, so the browser back button
 * is not tied to the router; a dummy history entry catches every press. Once we are on the home
 * screen with no modals we stop swallowing the event, so the next back really leaves the PWA.
 */
export function initBackTrap(): () => void {
  // Telegram has a back button of its own (below), and a history entry in its frame would trap the outer page's.
  if (!isWebBuild() || isTelegramMiniApp()) return () => {}

  function pushGuard(): void {
    history.pushState({ ryadomBackGuard: true }, '', location.href)
  }

  function handlePopState(): void {
    if (handleBackStep()) pushGuard()
  }

  pushGuard()
  window.addEventListener('popstate', handlePopState)
  return () => window.removeEventListener('popstate', handlePopState)
}

/**
 * The Mini App: Telegram's own back button in its header, shown whenever "back" has somewhere to go
 * inside the app and hidden on the home screen, where Telegram's "close" is the way out.
 */
export function initTelegramBackButton(): () => void {
  const app = telegramWebApp()
  if (!app?.isVersionAtLeast('6.1')) return () => {}
  const sync = () => {
    if (canGoBack()) app.BackButton.show()
    else app.BackButton.hide()
  }
  const handleClick = () => {
    handleBackStep()
    // The step animates; the state it leaves is known once the page or modal has finished moving.
    setTimeout(sync, 400)
  }
  // Router and modal events reach the app instance at run time, but its typings list only its own.
  const events = 'routeChanged modalOpened modalClosed tabShow pageAfterIn'
  type AppEventBus = {
    on(names: string, handler: () => void): void
    off(names: string, handler: () => void): void
  }
  let bus: AppEventBus | null = null
  let removed = false
  app.BackButton.onClick(handleClick)
  f7ready((instance) => {
    if (removed) return
    bus = instance as unknown as AppEventBus
    bus.on(events, sync)
    sync()
  })
  return () => {
    removed = true
    app.BackButton.offClick(handleClick)
    app.BackButton.hide()
    bus?.off(events, sync)
  }
}

/**
 * Light system bar icons: the interface is dark only. The same style is set in
 * capacitor.config.ts, but the native side re-applies it from the system theme after the page
 * loads, so we repeat it from JS on start and on every resume.
 */
export function initSystemBarsStyle(): () => void {
  if (!isNative()) return () => {}
  const apply = () => void SystemBars.setStyle({ style: SystemBarsStyle.Dark }).catch(() => {})
  apply()
  const timer = setTimeout(apply, 1500)
  const offResume = onAppResume(apply)
  return () => {
    clearTimeout(timer)
    offResume()
  }
}

export function isOnline(): boolean {
  return navigator.onLine
}

export function onNetworkChange(listener: (online: boolean) => void): () => void {
  const on = () => listener(true)
  const off = () => listener(false)
  window.addEventListener('online', on)
  window.addEventListener('offline', off)
  return () => {
    window.removeEventListener('online', on)
    window.removeEventListener('offline', off)
  }
}

/** App came back to the foreground. */
function onAppResume(listener: () => void): () => void {
  if (!isNative()) {
    const handler = () => {
      if (document.visibilityState === 'visible') listener()
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }
  let remove: (() => void) | null = null
  let removed = false
  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) listener()
  }).then((handle) => {
    if (removed) void handle.remove()
    else remove = () => void handle.remove()
  })
  return () => {
    removed = true
    remove?.()
  }
}
