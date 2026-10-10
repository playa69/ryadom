/**
 * What may leave the device or the server in an analytics event.
 *
 * The catalog (`events.ts`) already restricts what the code asks to send; this file is the second
 * line, applied to every event right before it is sent, so a mistake in a call site (or a PostHog
 * default such as `$current_url`) cannot put a secret or a piece of a conversation into the report.
 *
 * - Properties: only booleans, finite numbers, short strings and arrays of those. Keys that name
 *   personal data or free text are dropped whatever their value. Strings that look like an email
 *   address are dropped too.
 * - URLs: no fragment, no query except campaign parameters, and ids in the path become `:id`. The
 *   address of the password-reset screen carries a secret code in its query; it must never be reported.
 */

const MAX_STRING = 120
const MAX_ARRAY = 20

/** Keys compared with everything but letters and digits removed, lower case. */
const DENIED_KEYS = new Set([
  'text',
  'message',
  'msg',
  'body',
  'content',
  'comment',
  'note',
  'notes',
  'email',
  'mail',
  'password',
  'passwd',
  'pass',
  'token',
  'code',
  'secret',
  'name',
  'firstname',
  'lastname',
  'fullname',
  'username',
  'phone',
  'tel',
  'address',
  'takeaway',
  'greeting',
  'transcript',
  'summary',
  'title',
  'themes',
  'ip',
  'devicekey',
  'deviceid',
  'authorization',
  'cookie',
  'query',
  'search',
])

const DENIED_FRAGMENTS = ['password', 'token', 'secret', 'email', 'phone', 'authorization']

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isDeniedKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (DENIED_KEYS.has(normalized)) return true
  return DENIED_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

type Primitive = string | number | boolean

function cleanPrimitive(value: unknown): Primitive | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    if (EMAIL_LIKE.test(value)) return undefined
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  }
  return undefined
}

export type CleanProperties = Record<string, Primitive | Primitive[]>

/**
 * Keeps what is safe to report. Nested objects and `null` are dropped rather than walked: an event
 * property is a flat fact, and a nested object is where free text hides.
 */
export function sanitizeProperties(properties: object | null | undefined): CleanProperties {
  const clean: CleanProperties = {}
  if (!properties) return clean
  for (const [key, value] of Object.entries(properties)) {
    // PostHog's own `$`-prefixed fields are set by the SDK and handled by the URL scrubber.
    if (!key.startsWith('$') && isDeniedKey(key)) continue
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY).map(cleanPrimitive)
      if (items.every((item): item is Primitive => item !== undefined)) clean[key] = items
      continue
    }
    const primitive = cleanPrimitive(value)
    if (primitive !== undefined) clean[key] = primitive
  }
  return clean
}

// ── URLs ────────────────────────────────────────────────────────────────────────────────────

/** Campaign parameters are the only query that is useful for analytics and carries no secret. */
const KEPT_QUERY = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX = /^[0-9a-f]{16,}$/i
const LONG_NUMBER = /^\d{4,}$/
/** A path segment that is a random token rather than a word: long, mixed letters and digits. */
const OPAQUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{20,}$/

/** `/dialog/3f2a…` -> `/dialog/:id`. Words stay, identifiers do not. */
export function normalizePath(path: string): string {
  const [onlyPath = ''] = path.split(/[?#]/, 1)
  const segments = onlyPath.split('/').map((segment) => {
    if (!segment) return segment
    if (UUID.test(segment) || LONG_HEX.test(segment) || LONG_NUMBER.test(segment) || OPAQUE.test(segment)) return ':id'
    return segment
  })
  return segments.join('/') || '/'
}

/**
 * The address as reported: origin and normalized path, campaign parameters only, no fragment.
 * Something that is not a URL is cut at the first `?` or `#` and normalized as a path.
 */
export function sanitizeUrl(raw: string, base?: string): string {
  let url: URL
  try {
    url = new URL(raw, base ?? PLACEHOLDER_ORIGIN)
  } catch {
    return normalizePath(raw)
  }
  const kept = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (KEPT_QUERY.has(key.toLowerCase())) kept.set(key.toLowerCase(), value.slice(0, 80))
  }
  // A path with no origin stays a path: the placeholder only made it parseable.
  const hasOrigin = base !== undefined || /^[a-z][a-z0-9+.-]*:/i.test(raw)
  const query = kept.toString()
  return `${hasOrigin ? originOf(url) : ''}${normalizePath(url.pathname)}${query ? `?${query}` : ''}`
}

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid'

/** `URL.origin` is the string "null" for schemes such as `capacitor:`, which the store builds run under. */
function originOf(url: URL): string {
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : `${url.protocol}//${url.host}`
}

/** Fields of a PostHog event that hold a full URL. */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
  '$prev_pageview_pathname',
  '$session_entry_url',
  '$session_entry_referrer',
]
/** Fields that hold a path only. */
const PATH_PROPERTIES = ['$pathname', '$initial_pathname', '$session_entry_pathname']

/**
 * Advertising click ids. posthog-js copies them from the query string into event properties (and
 * their `$initial_` twins into the person), so stripping the URL is not enough. They identify one click
 * of one person to an ad network, which is exactly what this product should not hand out.
 */
const CLICK_ID_PARAMS = [
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'epik',
  'rdt_cid',
  'sccid',
  'yclid',
  'ysclid',
]

/**
 * Properties the SDK sets that can carry content: the document title of a screen may be built from
 * what is on it (a dialog's title, a person's name).
 */
const CONTENT_PROPERTIES = ['title', '$title']

function removeClickIdsAndContent(properties: Record<string, unknown>): void {
  for (const id of CLICK_ID_PARAMS) {
    delete properties[id]
    delete properties[`$initial_${id}`]
  }
  for (const key of CONTENT_PROPERTIES) delete properties[key]
}

interface ScrubbableEvent {
  properties?: Record<string, unknown> | undefined
  $set?: Record<string, unknown> | undefined
  $set_once?: Record<string, unknown> | undefined
}

function scrubProperties(properties: Record<string, unknown>): void {
  removeClickIdsAndContent(properties)
  for (const key of URL_PROPERTIES) {
    const value = properties[key]
    if (typeof value === 'string' && value && value !== '$direct') properties[key] = sanitizeUrl(value)
  }
  for (const key of PATH_PROPERTIES) {
    const value = properties[key]
    if (typeof value === 'string' && value) properties[key] = normalizePath(value)
  }
}

/**
 * For the SDK's `before_send` hook: fixes the URL fields of an event and clears the person
 * properties. Returns the same object, changed in place, because the hook expects the event back.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T | null): T | null {
  if (!event) return event
  if (event.properties) scrubProperties(event.properties)
  // The person's properties carry the same URL fields as the event (`$initial_current_url`,
  // `$initial_referrer`, …): a person profile is where a raw address would live the longest. They are
  // scrubbed BEFORE the generic cleaning, which would cut a long URL at 120 characters mid-query.
  for (const key of ['$set', '$set_once'] as const) {
    const person = event[key]
    if (!person) continue
    scrubProperties(person)
    event[key] = sanitizeProperties(person)
  }
  return event
}
