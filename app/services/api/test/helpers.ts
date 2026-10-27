import { expect, vi } from 'vitest'
import type { Hono } from 'hono'
import type { ServerAnalytics } from '@ryadom/analytics/server'
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

/** One report the server made to PostHog. `userId` is null for an anonymous one. */
export interface RecordedEvent {
  userId: string | null
  event: string
  properties: Record<string, unknown>
}

/** A stand-in for product analytics that remembers what was reported instead of sending it. */
export interface RecordingAnalytics extends ServerAnalytics {
  events: RecordedEvent[]
  identified: { userId: string; traits: Record<string, unknown> }[]
  /** Accounts the server asked PostHog to erase. */
  erased: string[]
}

export function recordingAnalytics(): RecordingAnalytics {
  const events: RecordedEvent[] = []
  const identified: RecordingAnalytics['identified'] = []
  const erased: string[] = []
  return {
    enabled: true,
    canErase: true,
    events,
    identified,
    erased,
    erasePerson: async (userId) => {
      erased.push(userId)
      return 'erased'
    },
    // The stand-in records everything it is given; honouring the choice is the real wrapper's job and is
    // tested against it (analytics.test.ts, "отказ человека от аналитики").
    setOptOut: () => {},
    capture: (userId, event, ...args) => void events.push({ userId, event, properties: { ...args[0] } }),
    captureAnonymous: (event, ...args) => void events.push({ userId: null, event, properties: { ...args[0] } }),
    identify: (userId, traits) => void identified.push({ userId, traits: { ...traits } }),
    captureException: () => {},
    shutdown: async () => {},
  }
}

/** What the app does when no PostHog key is configured: every call is a no-op. */
const DISABLED_ANALYTICS: ServerAnalytics = {
  enabled: false,
  canErase: false,
  erasePerson: async () => 'not_configured',
  setOptOut() {},
  capture() {},
  captureAnonymous() {},
  identify() {},
  captureException() {},
  shutdown: async () => {},
}

export interface TestApp {
  app: Hono<AppEnv>
  /** Reset the rate limit counters between assertions within one test. */
  resetLimits(): void
}

/** The application under test. */
export function makeApp(
  options: {
    policy?: ReleasePolicy
    env?: Record<string, string>
    logger?: Logger
    analytics?: ServerAnalytics
  } = {},
): TestApp {
  const rateLimiter = createRateLimiter()
  const app = createApp({
    env: parseEnv({ ...process.env, ...options.env }),
    logger: options.logger ?? createLogger('silent'),
    policy: staticPolicy(options.policy),
    rateLimiter,
    analytics: options.analytics ?? DISABLED_ANALYTICS,
  })
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
export function mockFetch(given: Record<string, Route>) {
  // The diary reads the recaps of the week's conversations with the marks: unless a test says otherwise there are none.
  const routes: Record<string, Route> = { 'GET http://agent.test/v1/users/*/recaps': () => json({ items: [], next: null }), ...given }
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

/**
 * The agent's dialog start as the real one behaves: a person has at most one open dialog. A plain start
 * changes nothing and returns it (`resumed: true`, with its `messageCount` and `lastActivityAt`). With
 * `new: true` the open dialog is ended and a fresh one created (`resumed: false`), except that an empty
 * one is just reused. Ids go d-1, d-2, ...; `say` puts messages into the person's open dialog.
 */
export function fakeAgentDialogs() {
  let counter = 0
  const open = new Map<string, { id: string; messages: number; lastActivityAt: string | null }>()
  /** Dialogs a fresh start ended, in order. */
  const ended: string[] = []
  const route: Route = ({ url, body }) => {
    const userId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
    const wantsNew = body !== '' && (JSON.parse(body) as { new?: unknown }).new === true
    let current = open.get(userId)
    if (current && !wantsNew) {
      return json({
        dialogId: current.id,
        resumed: true,
        greeting: 'Продолжим, где остановились.',
        sinceLastDialogHours: null,
        messageCount: current.messages,
        lastActivityAt: current.lastActivityAt,
      })
    }
    if (current && current.messages > 0) {
      ended.push(current.id)
      current = undefined
    }
    if (!current) {
      counter += 1
      current = { id: `d-${counter}`, messages: 0, lastActivityAt: null }
      open.set(userId, current)
    }
    return json({
      dialogId: current.id,
      resumed: false,
      greeting: 'Я рядом.',
      sinceLastDialogHours: null,
      messageCount: 0,
      lastActivityAt: null,
    })
  }
  return {
    route,
    ended,
    openOf: (userId: string) => open.get(userId)?.id ?? null,
    /** The person (or the agent) said something in the open dialog. */
    say(userId: string, messages = 1) {
      const current = open.get(userId)
      if (!current) throw new Error(`${userId} has no open dialog`)
      current.messages += messages
      current.lastActivityAt = new Date().toISOString()
    },
  }
}

export function mockAgent(overrides: Record<string, Route> = {}) {
  const dialogs = fakeAgentDialogs()
  const stub = mockFetch({
    'POST http://agent.test/v1/users/*/dialogs': dialogs.route,
    'GET http://agent.test/v1/users/*/dialogs': () => json({ items: [], next: null }),
    'DELETE http://agent.test/v1/users/*': () => new Response(null, { status: 204 }),
    ...overrides,
  })
  return { ...stub, dialogs }
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
