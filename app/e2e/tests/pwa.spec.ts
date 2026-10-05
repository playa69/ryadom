import { APP_URL } from '../playwright.config'
import { expect, test } from '../support/fixtures'

/** The PWA itself: manifest, service worker and the offline shell. */

test('манифест отдаётся и описывает приложение', async ({ request }) => {
  const response = await request.get(`${APP_URL}/manifest.webmanifest`)
  expect(response.status()).toBe(200)
  const manifest = (await response.json()) as Record<string, unknown>
  expect(manifest.name).toBe('Рядом')
  expect(manifest.display).toBe('standalone')
  expect(Array.isArray(manifest.icons)).toBe(true)
})

test('service worker регистрируется', async ({ page }) => {
  await page.goto(`${APP_URL}/`)
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    return Boolean(registration)
  })
  expect(registered).toBe(true)
})

test('страница приложения приходит с политикой безопасности', async ({ request }) => {
  const response = await request.get(`${APP_URL}/`)
  const csp = response.headers()['content-security-policy']
  expect(csp).toBeTruthy()
  // The conversation runs over a WebSocket to the same origin; without this it would silently fail.
  expect(csp).toContain('connect-src')
  expect(csp).toContain("frame-ancestors 'none'")
})

test('проверка живости отвечает', async ({ request }) => {
  const response = await request.get(`${APP_URL}/api/health`)
  expect(response.status()).toBe(200)
  expect((await response.json()).status).toBe('ok')
})
