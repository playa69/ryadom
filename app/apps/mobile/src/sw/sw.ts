/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

/**
 * Service worker for the web build: the offline app shell and updates on demand.
 *
 * `registerType: 'prompt'` in vite.config.ts: a new version waits for the update button instead of
 * swapping itself in, which could otherwise reload the screen mid-conversation.
 *
 * There is no push handling here: this stage has no push notifications at all.
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
