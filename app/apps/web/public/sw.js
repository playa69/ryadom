/*
 * Service worker of the web client: shows the mood reminder (Web Push) and opens the diary when it is
 * touched. It caches nothing and intercepts no request. The payload is JSON:
 * `{ title, body, deliveryId }`; the text is a gentle line chosen by the server.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = data.title || 'Рядом'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'Как ты сегодня? Отметь настроение в два касания',
      icon: 'favicon.svg',
      tag: 'mood-reminder',
      data: { deliveryId: data.deliveryId ?? null },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const deliveryId = event.notification.data && event.notification.data.deliveryId
  // The worker lives at <base>/sw.js, so the diary is the sibling path: the base path comes along.
  const base = new URL('.', self.location.href).pathname.replace(/\/$/, '')
  const target = `${base}/diary?from=reminder${deliveryId ? `&delivery=${encodeURIComponent(deliveryId)}` : ''}`
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
