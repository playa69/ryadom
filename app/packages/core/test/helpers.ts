import { expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLog, emailCodes, userCredentials, users, type EmailCodePurpose } from '@ryadom/db/schema'
import { getDb } from '../src/shared'
import { authenticationProcess, LoginOperation, RegisterOperation } from '../src/processes/authentication'
import { AcceptConsentsOperation, consentsProcess } from '../src/processes/consents'
import { ConfirmEmailOperation, emailConfirmationProcess } from '../src/processes/email-confirmation'
import { getSentEmails, type SentEmail } from '../src/services/email-sender-service'

export const PASSWORD = 'correct-horse-battery'
/** The first address from ADMIN_EMAILS in vitest.config.ts. */
export const ADMIN_EMAIL = 'admin@example.com'

let counter = 0
export function uniqueEmail(prefix = 'user'): string {
  counter += 1
  return `${prefix}-${counter}-${Date.now()}@example.com`
}

export async function registerUser(opts: { email?: string; password?: string; name?: string } = {}) {
  const result = await authenticationProcess.execute(
    new RegisterOperation({
      email: opts.email ?? uniqueEmail(),
      password: opts.password ?? PASSWORD,
      name: opts.name ?? 'Аня',
    }),
  )
  if (!result.success) throw new Error(`register failed: ${result.error}`)
  if (result.user.email === null) throw new Error('a registered user has an address')
  return { ...result.user, email: result.user.email }
}

/**
 * Confirms the address the way a person does, with the code from the letter. `callerUserId` is the
 * account the request is made from: an address held by a guest account only confirms from its own session.
 */
export async function confirmWithCode(email: string, callerUserId: string | null = null): Promise<void> {
  const code = codeFromEmail(lastEmailTo(email))
  const result = await emailConfirmationProcess.execute(
    new ConfirmEmailOperation({ email, code, callerUserId }),
  )
  if (!result.success) throw new Error(`confirm failed: ${result.error}`)
}

async function confirmEmailDirectly(userId: string): Promise<void> {
  await getDb().update(users).set({ isEmailConfirmed: true }).where(eq(users.id, userId))
}

/** The version of the terms the tests accept: any date will do, the core only records it. */
export const OFFER_VERSION = '2026-10-04'

/** What the first screen of the app does: all three agreements at once. */
export async function acceptConsents(userId: string, offerVersion = OFFER_VERSION): Promise<void> {
  const result = await consentsProcess.execute(
    new AcceptConsentsOperation({
      userId,
      ageConfirmed: true,
      disclaimerAccepted: true,
      offerAccepted: true,
      offerVersion,
    }),
  )
  if (!result.success) throw new Error(`accepting consents failed: ${result.error}`)
}

/**
 * A registered user with a confirmed address, so they can sign in. They have also agreed to the
 * terms, as everyone who got through the app has: a conversation is closed to anyone who has not.
 */
export async function registerConfirmedUser(
  opts: { email?: string; password?: string; name?: string; consents?: boolean } = {},
) {
  const user = await registerUser(opts)
  await confirmEmailDirectly(user.id)
  if (opts.consents !== false) await acceptConsents(user.id)
  return user
}

export async function blockDirectly(userId: string): Promise<void> {
  await getDb().update(users).set({ isActive: false }).where(eq(users.id, userId))
}

export function login(email: string, password = PASSWORD) {
  return authenticationProcess.execute(new LoginOperation({ email, password }))
}

export async function getUserRow(userId: string) {
  const [row] = await getDb().select().from(users).where(eq(users.id, userId))
  return row
}

/** Codes are not tied to a user, so they are counted by address. */
export async function countRows(userId: string, email: string) {
  const db = getDb()
  const [credentials, codes] = await Promise.all([
    db.select().from(userCredentials).where(eq(userCredentials.userId, userId)),
    db.select().from(emailCodes).where(eq(emailCodes.email, email)),
  ])
  return { credentials: credentials.length, codes: codes.length }
}

export async function codeRows(email: string, purpose?: EmailCodePurpose) {
  const rows = await getDb().select().from(emailCodes).where(eq(emailCodes.email, email))
  return purpose ? rows.filter((row) => row.purpose === purpose) : rows
}

export async function auditRows() {
  return getDb().select().from(auditLog)
}

export function emailsTo(address: string): SentEmail[] {
  return getSentEmails().filter((email) => email.to.toLowerCase() === address.toLowerCase())
}

export function lastEmailTo(address: string): SentEmail {
  const all = emailsTo(address)
  expect(all.length, `no email sent to ${address}`).toBeGreaterThan(0)
  return all[all.length - 1]!
}

/** The six-digit code from the letter. */
export function codeFromEmail(email: SentEmail): string {
  const match = email.text.match(/\b(\d{6})\b/)
  expect(match, `6-digit code not found in email "${email.subject}"`).toBeTruthy()
  return match![1]!
}

/** Moves the core clock: only Date is faked, timers stay real because the DB driver needs them. */
function travelTo(date: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(date)
}

export function travelBy(ms: number): void {
  travelTo(new Date(Date.now() + ms))
}

export const HOUR = 60 * 60 * 1000
export const MINUTE = 60 * 1000

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

interface FetchCall {
  method: string
  url: URL
  body: string
  headers: Headers
}

type Route = (call: FetchCall) => Response | Promise<Response>

/**
 * Replaces global fetch with a router from "METHOD origin/path" to a response. A `*` in the path
 * matches one segment, a user id for example. An unknown address fails the test, which makes it
 * visible when the code went somewhere the contract did not promise.
 */
export function mockFetch(routes: Record<string, Route>) {
  const calls: FetchCall[] = []
  // Longer patterns first: `/dialogs/*` must win over `/dialogs`.
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
    const call: FetchCall = { method, url, body, headers: new Headers(init?.headers) }
    calls.push(call)
    const target = `${url.origin}${url.pathname}`
    const found = patterns.find((pattern) => pattern.method === method && pattern.regex.test(target))
    if (!found) throw new Error(`Unexpected fetch: ${method} ${url.href}`)
    return routes[found.key]!(call)
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
function fakeAgentDialogs() {
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

/** An agent that answers everything correctly, for tests about our code rather than about it. */
export function mockAgent(overrides: Record<string, Route> = {}) {
  const dialogs = fakeAgentDialogs()
  const stub = mockFetch({
    'POST http://agent.test/v1/users/*/dialogs': dialogs.route,
    'GET http://agent.test/v1/users/*/dialogs': () => json({ items: [], next: null }),
    'DELETE http://agent.test/v1/users/*': () => noContent(),
    ...overrides,
  })
  return { ...stub, dialogs }
}
