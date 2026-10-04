/**
 * Service worker registration for the web build.
 *
 * Done by hand instead of `virtual:pwa-register`: that virtual module only exists while VitePWA
 * is enabled (web mode only), and this file can end up in the graph of a store build too.
 *
 * `registerType: 'prompt'` in vite.config.ts: a new version waits for the "Update" button
 * instead of replacing itself mid-conversation.
 */

function notifyIfWaiting(registration: ServiceWorkerRegistration, onUpdateAvailable: () => void): void {
  if (registration.waiting && navigator.serviceWorker.controller) onUpdateAvailable()
}

/** Called once at startup from app-update.ts. No-op outside the web build. */
export function initServiceWorker(onUpdateAvailable: () => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {}

  let registration: ServiceWorkerRegistration | null = null

  void navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      registration = reg
      notifyIfWaiting(reg, onUpdateAvailable)
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') notifyIfWaiting(reg, onUpdateAvailable)
        })
      })
    })
    .catch(() => {
      // No service worker: the app simply has no offline mode and no update banner.
    })

  // An installed PWA can stay open for days, so check periodically, not only on load.
  const interval = setInterval(() => void registration?.update(), 60 * 60 * 1000)
  return () => clearInterval(interval)
}

/** The "Update" button: activate the waiting worker and reload. */
export function applyServiceWorkerUpdate(): void {
  let reloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    location.reload()
  })
  void navigator.serviceWorker
    .getRegistration()
    .then((reg) => reg?.waiting?.postMessage({ type: 'SKIP_WAITING' }))
    .catch(() => location.reload())
}
