import { APP_URL, PWA_URL } from '../playwright.config'
import { expect, test } from '../support/fixtures'

/**
 * The PWA itself: manifest and service worker. The security headers, the cache rules and the SPA
 * fallback belong to the nginx image (apps/mobile/nginx) and are checked on the image, not here: the
 * server in this stack is `vite preview`.
 */

test('манифест отдаётся и описывает приложение', async ({ request }) => {
  const response = await request.get(`${PWA_URL}/manifest.webmanifest`)
  expect(response.status()).toBe(200)
  const manifest = (await response.json()) as Record<string, unknown>
  expect(manifest.name).toBe('Рядом')
  expect(manifest.display).toBe('standalone')
  expect(Array.isArray(manifest.icons)).toBe(true)
})

test('service worker регистрируется', async ({ page }) => {
  await page.goto(`${PWA_URL}/`)
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    return Boolean(registration)
  })
  expect(registered).toBe(true)
})

test('проверка живости отвечает', async ({ request }) => {
  const response = await request.get(`${APP_URL}/api/health`)
  expect(response.status()).toBe(200)
  expect((await response.json()).status).toBe('ok')
})

test('PWA ходит в API через свой origin: /api проксируется', async ({ request }) => {
  // This is how the client reaches the API behind the gateway (same host, `/api` routed to the API).
  const response = await request.get(`${PWA_URL}/api/health`)
  expect(response.status()).toBe(200)
  expect((await response.json()).status).toBe('ok')
})
