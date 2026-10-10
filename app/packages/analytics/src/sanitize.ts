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
    // Cut first: the check is quadratic on a long string with no spaces, and what is cut is not sent anyway.
    const short = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
    return EMAIL_LIKE.test(short) ? undefined : short
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
/**
 * What a campaign value may look like: a short slug. A free value is where a name or an address ends up
 * (`utm_content=anna%40example.com`, `utm_term=Anna+Ivanova`), and the query is decoded before the check,
 * so an encoded `@` does not get past it.
 */
const CAMPAIGN_VALUE = /^[A-Za-z0-9_.-]{1,40}$/

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
    if (KEPT_QUERY.has(key.toLowerCase()) && CAMPAIGN_VALUE.test(value)) kept.set(key.toLowerCase(), value)
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
  'qclid',
  'oppref',
  'irclid',
  '_kx',
  'yclid',
  'ysclid',
  // A search phrase from the referrer: what a person typed into a search engine.
  'ph_keyword',
]

/**
 * Properties the SDK sets that can carry content: the document title of a screen may be built from
 * what is on it (a dialog's title, a person's name).
 */
const CONTENT_PROPERTIES = ['title', '$title']

/** The SDK repeats every campaign parameter as `$initial_<id>` (person) and `$session_entry_<id>` (every event of the session). */
const CAMPAIGN_PREFIXES = ['', '$initial_', '$session_entry_']
/** `utm_*` as the SDK copies them into events, with the same free-value problem as in an address. */
const CAMPAIGN_PROPERTY = /^(?:\$initial_|\$session_entry_)?(?:utm_[a-z]+|gad_source)$/

function removeClickIdsAndContent(properties: Record<string, unknown>): void {
  for (const id of CLICK_ID_PARAMS) {
    for (const prefix of CAMPAIGN_PREFIXES) delete properties[`${prefix}${id}`]
  }
  for (const key of CONTENT_PROPERTIES) delete properties[key]
  for (const key of Object.keys(properties)) {
    if (key.startsWith('data-ph-capture-attribute-')) delete properties[key]
    else if (CAMPAIGN_PROPERTY.test(key) && !(typeof properties[key] === 'string' && CAMPAIGN_VALUE.test(properties[key]))) {
      delete properties[key]
    }
  }
}

interface ScrubbableEvent {
  properties?: Record<string, unknown> | undefined
  $set?: Record<string, unknown> | undefined
  $set_once?: Record<string, unknown> | undefined
}

/**
 * The start of the hour. Events about nobody (SOS, a crisis signal) are dated with it: the minute of
 * such an event, set beside the minute of a person's own activity, would point at that person.
 */
export function roundedToHour(date: Date = new Date()): Date {
  return new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── Clicks: the structure of the page, never its text ───────────────────────────────────────

/**
 * What of an element survives in a click event: where it is in the markup and the marker we put on
 * elements ourselves (`data-ph-capture="name"`). The text, the link, the id, the label, the value and
 * every other attribute are what a person typed or what a screen was built from (a name in a greeting,
 * a dialog's title), so they are cut whatever the SDK was told.
 */
const KEPT_ELEMENT_ATTRIBUTES = new Set(['nth-child', 'nth-of-type', 'attr__data-ph-capture'])
const MAX_ELEMENTS = 30
const MARKER = /^[A-Za-z0-9_.-]{1,40}$/
const TAG = /^[A-Za-z][A-Za-z0-9-]{0,30}$/
/** Where the tag and classes of an element end and its attributes begin in `$elements_chain`. */
const CHAIN_ATTRIBUTES_START = /:(?=(?:attr_|href=|nth-child=|nth-of-type=|text=))/
const CHAIN_ATTRIBUTE = /([A-Za-z0-9_-]+)="((?:\\"|[^"])*)"/g
const HEAD_FORBIDDEN = /[^A-Za-z0-9_\-.:/[\]%#()&*,!+~>=|]/g
/** `\"` followed by what could follow a closing quote (the next attribute, `;`, the end): see `scrubElementsChain`. */
const AMBIGUOUS_QUOTE = /\\"(?:[A-Za-z0-9_-]+="|;|$)/

/** `px-4.card-3f2a…` -> `px-4.card-:id`: a class that carries an identifier loses it. */
function maskIdentifiers(dotted: string): string {
  return dotted
    .split('.')
    .map((token) => (UUID.test(token) || LONG_HEX.test(token) || LONG_NUMBER.test(token) || OPAQUE.test(token) ? ':id' : token))
    .join('.')
}

/** Cuts `$elements_chain` at the `;` between elements, but not at one inside a quoted value (a text). */
function splitChain(chain: string): string[] {
  const elements: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < chain.length; i++) {
    const char = chain[i]!
    if (inQuotes && char === '\\' && chain[i + 1] === '"') {
      current += '\\"'
      i++
      continue
    }
    if (char === '"') inQuotes = !inQuotes
    if (char === ';' && !inQuotes) {
      elements.push(current)
      current = ''
      continue
    }
    current += char
  }
  elements.push(current)
  return elements
}

/**
 * `$elements_chain` of a click, rebuilt from tag, classes, position and our marker only:
 * `button.btn:nth-child="2"nth-of-type="1"text="Привет, Аня"href="/x"` -> `button.btn:nth-child="2"nth-of-type="1"`.
 * The format stays the one PostHog reads, so its own views of clicks keep working.
 */
export function scrubElementsChain(chain: string): string {
  // A value that ends in a backslash makes its closing quote look like an escaped one (`C:\"`), and from
  // there the chain cannot be read reliably: a piece of a text could be taken for the next element. None of
  // such a chain is kept. (Found by fuzzing the real serializer.)
  if (AMBIGUOUS_QUOTE.test(chain)) return ''
  return splitChain(chain)
    .slice(0, MAX_ELEMENTS)
    .map((element) => {
      const start = element.search(CHAIN_ATTRIBUTES_START)
      // An element with no attributes where there always are some (`nth-child`) is not one we wrote.
      if (start === -1) return ''
      const head = element.slice(0, start).replace(HEAD_FORBIDDEN, '').slice(0, 200)
      const [tag = '', ...classes] = head.split('.')
      if (!TAG.test(tag)) return ''
      const kept: string[] = []
      if (start !== -1) {
        for (const [, key = '', raw = ''] of element.slice(start + 1).matchAll(CHAIN_ATTRIBUTE)) {
          if (!KEPT_ELEMENT_ATTRIBUTES.has(key)) continue
          const ok = key === 'attr__data-ph-capture' ? MARKER.test(raw) : /^\d{1,3}$/.test(raw)
          if (ok) kept.push(`${key}="${raw}"`)
        }
      }
      return `${[tag, ...classes.map((c) => maskIdentifiers(c))].join('.')}:${kept.join('')}`
    })
    .filter(Boolean)
    .join(';')
}

/** The `$elements` array (sent by dead clicks) with the same rule as the chain. */
function scrubElementList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_ELEMENTS).map((raw) => {
    const element = isRecord(raw) ? raw : {}
    const kept: Record<string, unknown> = {}
    if (typeof element.tag_name === 'string' && TAG.test(element.tag_name)) kept.tag_name = element.tag_name
    for (const key of ['nth_child', 'nth_of_type']) {
      const position = element[key]
      if (typeof position === 'number' && Number.isFinite(position)) kept[key] = position
    }
    if (Array.isArray(element.classes)) {
      kept.classes = element.classes
        .filter((name): name is string => typeof name === 'string')
        .slice(0, 20)
        .map((name) => maskIdentifiers(name.replace(HEAD_FORBIDDEN, '')).slice(0, 80))
    }
    const marker = element['attr__data-ph-capture']
    if (typeof marker === 'string' && MARKER.test(marker)) kept['attr__data-ph-capture'] = marker
    return kept
  })
}

/** Heatmaps: the keys are page addresses, with their query strings and ids; the entries are coordinates. */
function scrubHeatmap(value: unknown): Record<string, unknown[]> {
  const clean: Record<string, unknown[]> = {}
  if (!isRecord(value)) return clean
  for (const [address, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue
    const route = sanitizeUrl(address)
    const points = entries.slice(0, 500).filter(isRecord).map((entry) => sanitizeProperties(entry))
    clean[route] = [...(clean[route] ?? []), ...points]
  }
  return clean
}

function scrubClickProperties(properties: Record<string, unknown>): void {
  delete properties.$el_text
  delete properties.$selected_content
  delete properties.$copy_type
  // Where a click on an outside link leads: the site, not the page. A path such as `/anna_ivanova` of a
  // messenger or a social network points at one person.
  if ('$external_click_url' in properties) {
    const target = properties.$external_click_url
    let origin = ''
    try {
      const url = typeof target === 'string' ? new URL(target) : null
      if (url && (url.protocol === 'http:' || url.protocol === 'https:')) origin = url.origin
    } catch {
      // Not an address: nothing is kept.
    }
    if (origin) properties.$external_click_url = origin
    else delete properties.$external_click_url
  }
  if (typeof properties.$elements_chain === 'string') {
    properties.$elements_chain = scrubElementsChain(properties.$elements_chain)
  }
  if ('$elements' in properties) properties.$elements = scrubElementList(properties.$elements)
  if ('$heatmap_data' in properties) properties.$heatmap_data = scrubHeatmap(properties.$heatmap_data)
}

// ── Web vitals ──────────────────────────────────────────────────────────────────────────────

const WEB_VITAL_EVENT = /^\$web_vitals_.*_event$/
const WEB_VITAL_FIELDS = ['name', 'value', 'rating', 'delta', 'navigationType']

/** A web vital is a number and a verdict; the SDK's attribution adds selectors and resource addresses of the page. */
function scrubWebVitals(properties: Record<string, unknown>): void {
  for (const key of Object.keys(properties)) {
    if (!WEB_VITAL_EVENT.test(key)) continue
    const metric = properties[key]
    if (!isRecord(metric)) {
      delete properties[key]
      continue
    }
    properties[key] = Object.fromEntries(
      WEB_VITAL_FIELDS.filter((field) => ['number', 'string'].includes(typeof metric[field])).map((field) => [
        field,
        metric[field],
      ]),
    )
  }
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────

const MAX_ERROR_TEXT = 80
const MAX_FRAMES = 50
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/g
/** What is between a pair of quotes: the engine copies a piece of the offending input there. */
const QUOTED_IN_TEXT = /(["'`])(?:(?!\1)[\s\S])*\1/g

/**
 * The text of an error: `Unexpected token 'П', "Привет, ме"... is not valid JSON` names a piece of what
 * a person wrote. What stays is the kind of mistake: quoted pieces are emptied, addresses and mail
 * addresses replaced, the rest cut short.
 */
function scrubErrorText(text: string): string {
  return text
    .replace(URL_IN_TEXT, '<url>')
    .replace(EMAIL_IN_TEXT, '<email>')
    .replace(QUOTED_IN_TEXT, (_, quote: string) => `${quote}…${quote}`)
    .slice(0, MAX_ERROR_TEXT)
}

function scrubFrame(raw: unknown): Record<string, unknown> {
  const frame = isRecord(raw) ? raw : {}
  const kept: Record<string, unknown> = {}
  for (const key of ['lineno', 'colno']) {
    if (typeof frame[key] === 'number' && Number.isFinite(frame[key])) kept[key] = frame[key]
  }
  if (typeof frame.in_app === 'boolean') kept.in_app = frame.in_app
  // The file of a frame is the page's own address for a script that was injected: it carries the page's query.
  for (const key of ['filename', 'abs_path']) {
    if (typeof frame[key] === 'string') kept[key] = sanitizeUrl(frame[key])
  }
  for (const key of ['function', 'module', 'platform', 'chunk_id']) {
    const value = frame[key]
    if (typeof value === 'string') kept[key] = scrubErrorText(value)
  }
  return kept
}

/** `$exception_list` rebuilt from its parts: the kind, the cleaned text, how it was caught and the frames. */
function scrubExceptionList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.slice(0, 10).map((raw) => {
    const item = isRecord(raw) ? raw : {}
    const kept: Record<string, unknown> = {}
    if (typeof item.type === 'string') kept.type = item.type.replace(/[^A-Za-z0-9_.$ -]/g, '').slice(0, 80)
    if (typeof item.value === 'string') kept.value = scrubErrorText(item.value)
    if (isRecord(item.mechanism)) {
      const mechanism: Record<string, unknown> = {}
      if (typeof item.mechanism.type === 'string') mechanism.type = item.mechanism.type.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)
      for (const flag of ['handled', 'synthetic']) {
        if (typeof item.mechanism[flag] === 'boolean') mechanism[flag] = item.mechanism[flag]
      }
      kept.mechanism = mechanism
    }
    if (isRecord(item.stacktrace) && Array.isArray(item.stacktrace.frames)) {
      kept.stacktrace = {
        type: 'raw',
        frames: item.stacktrace.frames.slice(-MAX_FRAMES).map(scrubFrame),
      }
    }
    return kept
  })
}

function scrubExceptionProperties(properties: Record<string, unknown>): void {
  if ('$exception_list' in properties) properties.$exception_list = scrubExceptionList(properties.$exception_list)
  if (typeof properties.$exception_message === 'string') {
    properties.$exception_message = scrubErrorText(properties.$exception_message)
  }
  if (typeof properties.$exception_source === 'string') {
    properties.$exception_source = sanitizeUrl(properties.$exception_source)
  }
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
  scrubClickProperties(properties)
  scrubWebVitals(properties)
  scrubExceptionProperties(properties)
  // Person properties can also travel inside the properties of an event (`$set`, `$set_once`).
  for (const key of ['$set', '$set_once']) {
    const person = properties[key]
    if (!isRecord(person)) continue
    scrubProperties(person)
    properties[key] = sanitizeProperties(person)
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
