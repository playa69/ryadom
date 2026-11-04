import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { ADMIN_URL, APP_URL, PUSH_URL } from '../playwright.config'
import { clearMailbox, waitForCode } from './mail'

/** The only address the stack lists in ADMIN_EMAILS (scripts/stack.mjs). */
export const ADMIN_EMAIL = 'admin@ryadom.local'
/** The push project the stack holds a service token for, and that token (scripts/stack.mjs). */
export const PUSH_PROJECT = 'e2eProject'
export const PUSH_SERVICE_TOKEN = 'e2e-only-push-service-token'

export function adminUrl(path = '/'): string {
  return `${ADMIN_URL}${path}`
}

/** Signs in to the admin console the way an admin does: the address, then the code from the letter. */
export async function signInToAdmin(page: Page): Promise<void> {
  await clearMailbox()
  await page.goto(adminUrl('/login'))
  await page.getByLabel('Рабочая почта').fill(ADMIN_EMAIL)
  await page.getByRole('button', { name: 'Прислать код' }).click()
  await page.getByLabel(/Код из письма/).fill(await waitForCode(ADMIN_EMAIL))
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page).toHaveURL(/\/users/)
}

/**
 * What the Android app does once notifications are on: `POST /api/notifications/subscriptions` with the token RuStore
 * gave it. The token picks how the stub answers a send (`gone-…` — 404, `broken-…` — 500, see dev/push-mock).
 */
export async function subscribeDevice(
  request: APIRequestContext,
  accessToken: string,
  token: string,
  appId = 'ru.ryadom.companion',
): Promise<string> {
  const response = await request.post(`${APP_URL}/api/notifications/subscriptions`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { channel: 'rustore', token, projectId: PUSH_PROJECT, appId },
  })
  expect(response.status(), 'подписка устройства').toBe(200)
  const body = (await response.json()) as { status: boolean; result: { subscriptionId: string } }
  expect(body.status, 'подписка принята').toBe(true)
  return body.result.subscriptionId
}

export interface ReceivedPush {
  projectId: string
  authorization: string
  status: number
  message: { token: string; notification?: { title?: string; body?: string }; data?: Record<string, string> }
}

/** What reached the push service for this token, the refused sends included. */
export async function pushesTo(token: string): Promise<ReceivedPush[]> {
  const response = await fetch(`${PUSH_URL}/dev/messages?token=${encodeURIComponent(token)}`)
  if (!response.ok) throw new Error(`заглушка RuStore Push ответила ${response.status}`)
  return ((await response.json()) as { messages: ReceivedPush[] }).messages
}

export async function clearPushes(): Promise<void> {
  await fetch(`${PUSH_URL}/dev/messages`, { method: 'DELETE' })
}
