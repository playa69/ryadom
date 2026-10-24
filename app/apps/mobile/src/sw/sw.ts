/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

/**
 * Service worker for the web build: the offline app shell and updates on demand.
 *
 * `registerType: 'prompt'` in vite.config.ts: a new version waits for the update button instead of
 * swapping itself in, which could otherwise reload the screen mid-conversation.
 *
 * Push: the mood reminder (`REQ-WELL-04`) arrives as Web Push with `{ title, body, deliveryId }`. The text is
 * shown as it came; a tap opens (or brings forward) the app on the diary.
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA: every in-app navigation is served by the cached index.html. `/api/*` is excluded because
// it must never be answered from the cache.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//],
  }),
)

self.addEventListener('message', (event) => {
  // The update button on the banner (lib/service-worker.ts).
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') void self.skipWaiting()
})

interface ReminderPayload {
  title?: string
  body?: string
  deliveryId?: number
}

self.addEventListener('push', (event) => {
  let payload: ReminderPayload = {}
  try {
    payload = (event.data?.json() as ReminderPayload | undefined) ?? {}
  } catch {
    // A push without a readable body still shows the plain reminder.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Рядом', {
      body: payload.body ?? 'Как ты сегодня? Отметь настроение в два касания',
      icon: `${self.registration.scope}pwa-192x192.png`,
      badge: `${self.registration.scope}pwa-192x192.png`,
      // One reminder a day: a newer one replaces the older instead of piling up.
      tag: 'mood-reminder',
      data: { deliveryId: payload.deliveryId ?? null },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const deliveryId = (event.notification.data as { deliveryId?: number | null } | undefined)?.deliveryId ?? null
  const url = new URL(`diary/?from=reminder${deliveryId ? `&delivery=${deliveryId}` : ''}`, self.registration.scope).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => w.url.startsWith(self.registration.scope))
      if (open) {
        // The app is already open: bring it forward and let it switch to the diary by itself.
        await open.focus()
        open.postMessage({ type: 'OPEN_DIARY', deliveryId })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
