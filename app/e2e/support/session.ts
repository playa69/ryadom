import { expect, type APIRequestContext, type Page } from '@playwright/test'
import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import { APP_URL } from '../playwright.config'

/**
 * What the tests need to know about a client's session without reaching into its storage: the
 * clients keep the refresh token in different places (localStorage, the Capacitor secure-storage
 * shim), but every one of them receives it in a response of the same few routes.
 */

export interface SessionTracker {
  /** The newest refresh token the page has received. */
  refreshToken(): string
  /** The newest access token the page has received: good for 15 minutes, and asking with it rotates nothing. */
  accessToken(): string
  /** The account the page last signed in as (device and password sign-in answer with it). */
  userId(): string
}

/** Routes that hand out a token pair. A refresh answers with the pair alone, the others add the user. */
const TOKEN_ROUTES = /\/api\/auth\/(device|login|refresh|telegram)$/

interface TokenResult {
  user?: { id?: string }
  tokens?: { accessToken?: string; refreshToken?: string }
  accessToken?: string
  refreshToken?: string
}

/** Start it before the first navigation; the page's own calls are what it listens to. */
export function trackSession(page: Page): SessionTracker {
  let refreshToken = ''
  let accessToken = ''
  let userId = ''
  page.on('response', async (response) => {
    if (!TOKEN_ROUTES.test(new URL(response.url()).pathname) || !response.ok()) return
    // The body can be gone when the page has already moved on; the next response will bring it.
    const body = (await response.json().catch(() => null)) as {
      status?: boolean
      result?: TokenResult
    } | null
    const result = body?.status ? body.result : null
    if (!result) return
    refreshToken = result.tokens?.refreshToken ?? result.refreshToken ?? refreshToken
    accessToken = result.tokens?.accessToken ?? result.accessToken ?? accessToken
    userId = result.user?.id ?? userId
  })
  return {
    refreshToken() {
      expect(refreshToken, 'клиент ещё не получил refresh-токен').not.toBe('')
      return refreshToken
    },
    accessToken() {
      expect(accessToken, 'клиент ещё не получил access-токен').not.toBe('')
      return accessToken
    },
    userId() {
      expect(userId, 'клиент ещё не вошёл').not.toBe('')
      return userId
    },
  }
}

/**
 * Whether a refresh with this token still gets a new session. It is refused two ways: a 401 for a
 * session that was ended (signed out, revoked, expired), and a refusal in the envelope for an account
 * that is gone or blocked. Asking with a live token rotates it, so a test must not ask with the token
 * of a page that is still in use.
 */
export async function sessionAlive(request: APIRequestContext, refreshToken: string): Promise<boolean> {
  const response = await request.post(`${APP_URL}/api/auth/refresh`, { data: { refreshToken } })
  if (response.status() !== 200) return false
  const body = (await response.json()) as { status: boolean }
  return body.status
}

/** What `POST /api/auth/device` answers, for tests that speak to the API as a client would. */
export interface DeviceSession {
  isNewAccount: boolean
  user: { id: string; email: string | null }
  tokens: { accessToken: string; refreshToken: string }
}

/** Signs in with device credentials the way a client does, to see whose account they open now. */
export async function deviceLogin(
  request: APIRequestContext,
  device: { deviceId: string; deviceKey: string },
): Promise<DeviceSession> {
  const response = await request.post(`${APP_URL}/api/auth/device`, { data: device })
  expect(response.status(), 'вход по устройству').toBe(200)
  const body = (await response.json()) as { status: boolean; result: DeviceSession }
  expect(body.status, 'вход по устройству принят').toBe(true)
  return body.result
}

/** The profile the server holds for this access token: what it knows about the account, not what the screen shows. */
export async function profileOf(request: APIRequestContext, accessToken: string): Promise<MeApiResponse> {
  const response = await request.get(`${APP_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  expect(response.status(), 'профиль').toBe(200)
  const body = (await response.json()) as { status: boolean; result: MeApiResponse }
  expect(body.status, 'профиль отдан').toBe(true)
  return body.result
}

/** What the server answers to "start a conversation": the code of a refusal, or null when it let the person in. */
export async function startDialogRefusal(
  request: APIRequestContext,
  accessToken: string,
): Promise<string | null> {
  const response = await request.post(`${APP_URL}/api/dialogs`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: {},
  })
  expect(response.status(), 'старт разговора').toBe(200)
  const body = (await response.json()) as { status: boolean; errorCode?: string }
  return body.status ? null : (body.errorCode ?? 'UNKNOWN')
}

/**
 * The device credentials a client keeps in the browser's storage; null once it has forgotten them.
 * The web app writes the JSON itself, the secure-storage shim of the PWA wraps it once more, so the
 * value is unwrapped until it is an object.
 */
export async function storedDevice(page: Page): Promise<{ deviceId: string; deviceKey: string } | null> {
  // The key is `ryadom_device` in the web app; the shim of the PWA may add a prefix of its own.
  const raw = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => /(^|_|\.)device$/.test(name))
    return key ? localStorage.getItem(key) : null
  })
  let value: unknown = raw
  for (let depth = 0; typeof value === 'string' && depth < 3; depth += 1) value = JSON.parse(value)
  return value && typeof value === 'object' ? (value as { deviceId: string; deviceKey: string }) : null
}
