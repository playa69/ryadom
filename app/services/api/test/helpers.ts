import { expect, vi } from 'vitest'
import type { Hono } from 'hono'
import { getSentEmails } from '@ryadom/core/services/email-sender-service'
import { createApp } from '../src/app'
import type { AppEnv } from '../src/lib/context'
import { parseEnv } from '../src/lib/env'
import { createLogger, type Logger } from '../src/lib/logger'
import { createRateLimiter } from '../src/lib/rate-limit'
import { EMPTY_POLICY, type PolicySource, type ReleasePolicy } from '../src/lib/release-policy'
import type { ApiEnvelope } from '@ryadom/contracts/api/envelope'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'

export const PASSWORD = 'correct-horse-battery'

/** Version policy straight from an object: tests need no env and no OTA bundle on disk. */
export function staticPolicy(policy: ReleasePolicy = EMPTY_POLICY): PolicySource {
  return { get: () => policy }
}

export interface TestApp {
  app: Hono<AppEnv>
  /** Reset the rate limit counters between assertions within one test. */
  resetLimits(): void
}

/**
 * The application under test. `pwaRoot: null` because serving the PWA is covered end to end
 * against a real build; otherwise the result would depend on whether `dist/pwa` exists locally.
 */
export function makeApp(
  options: { policy?: ReleasePolicy; env?: Record<string, string>; logger?: Logger } = {},
): TestApp {
  const rateLimiter = createRateLimiter()
  const app = createApp(
    {
      env: parseEnv({ ...process.env, ...options.env }),
      logger: options.logger ?? createLogger('silent'),
      policy: staticPolicy(options.policy),
      rateLimiter,
    },
    null,
  )
  return { app, resetLimits: () => rateLimiter.reset() }
}

export interface CallResult<T> {
  status: number
  envelope: ApiEnvelope<T>
}

/** A request to the app whose response comes back as an envelope. */
export async function call<T>(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<CallResult<T>> {
  const requestHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...headers }
  if (token) requestHeaders.Authorization = `Bearer ${token}`
  const response = await app.request(path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, envelope: (await response.json()) as ApiEnvelope<T> }
}

export function ok<T>(result: CallResult<T>): T {
  expect(result.status).toBe(200)
  if (!result.envelope.status) throw new Error(`refused: ${result.envelope.errorCode}`)
  return result.envelope.result
}

export function refusedWith(result: CallResult<unknown>, code: string): void {
  expect(result.status).toBe(200)
  expect(result.envelope).toMatchObject({ status: false, errorCode: code })
}

/** Any non-200: the body is only `{ errorMessage }`, with no code. */
export async function expectTransportError(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status)
  const body = (await response.json()) as Record<string, unknown>
  expect(Object.keys(body)).toEqual(['errorMessage'])
  expect(typeof body.errorMessage).toBe('string')
}

let counter = 0
export function uniqueEmail(prefix = 'user'): string {
  counter += 1
  return `${prefix}-${counter}-${Date.now()}@example.com`
}

/** The six-digit code from the latest email sent to that address. */
export function codeFor(email: string): string {
  const letter = [...getSentEmails()].reverse().find((sent) => sent.to.toLowerCase() === email.toLowerCase())
  const code = letter?.text.match(/\b(\d{6})\b/)?.[1]
  expect(code, `no code sent to ${email}`).toBeTruthy()
  return code!
}

type Route = (call: {
  method: string
  url: URL
  body: string
  headers: Headers
}) => Response | Promise<Response>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A fetch stub: the key is "METHOD origin/path", and `*` in the path matches one segment. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; body: string; headers: Headers }[] = []
  const patterns = Object.keys(routes)
    .sort((a, b) => b.length - a.length)
    .map((key) => {
      const [method, target] = key.split(' ')
      const regex = new RegExp(`^${target!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`)
      return { key, method: method!, regex }
    })

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body === undefined || init.body === null ? '' : String(init.body)
    const entry = { method, url, body, headers: new Headers(init?.headers) }
    calls.push(entry)
    const target = `${url.origin}${url.pathname}`
    const found = patterns.find((pattern) => pattern.method === method && pattern.regex.test(target))
    if (!found) throw new Error(`Unexpected fetch: ${method} ${url.href}`)
    return routes[found.key]!(entry)
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

export function mockAgent(overrides: Record<string, Route> = {}) {
  return mockFetch({
    'POST http://agent.test/v1/users/*/dialogs': () =>
      json({ dialogId: 'd-1', resumed: false, greeting: 'Я рядом.', sinceLastDialogHours: null }),
    'GET http://agent.test/v1/users/*/dialogs': () => json({ items: [], next: null }),
    'DELETE http://agent.test/v1/users/*': () => new Response(null, { status: 204 }),
    ...overrides,
  })
}

/** What the first screen of the app sends: all three agreements, in the version it showed. */
export async function acceptConsents(app: Hono<AppEnv>, accessToken: string): Promise<void> {
  ok(
    await call(
      app,
      'POST',
      '/api/auth/me/consents',
      { ageConfirmed: true, disclaimerAccepted: true, offerAccepted: true, offerVersion: POLICY_VERSION },
      accessToken,
    ),
  )
}

/**
 * Register, confirm the email with the code and sign in, the way a person does it. The terms are
 * accepted as well, as they are on the first screen: a conversation is closed to anyone who has not.
 */
export async function signUpAndIn(
  app: Hono<AppEnv>,
  email = uniqueEmail(),
  options: { consents?: boolean } = {},
) {
  ok(await call(app, 'POST', '/api/auth/register', { email, password: PASSWORD, name: 'Аня' }))
  ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))
  const login = ok<{
    user: { id: string; email: string }
    tokens: { accessToken: string; refreshToken: string }
  }>(await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }))
  if (options.consents !== false) await acceptConsents(app, login.tokens.accessToken)
  return login
}
