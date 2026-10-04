import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Tracing context of the current request: the five tracing headers every service of the repository
 * takes and passes on (`.agents/skills/api-headers-rules`), under the names they have in log
 * records. It is read once at the entry (the HTTP middleware, the WebSocket upgrade) and kept in
 * AsyncLocalStorage, so log records and outgoing calls pick it up without it travelling through
 * function arguments.
 */
export interface RequestContext {
  /** `x-trace-id`: id of the request across services. */
  rqUId?: string
  /** `x-request-time`: when the caller sent it. */
  rqTime?: string
  /** `x-client-id`: the calling system. */
  systemId?: string
  /** `x-session-id`: session of the caller. */
  gwSessionId?: string
  /** `x-user-id`: the user. */
  userId?: string
}

/** Header names on the wire, by context field. Must match `TracingHeader` in the contracts. */
export const TRACING_HEADERS = {
  rqUId: 'x-trace-id',
  rqTime: 'x-request-time',
  systemId: 'x-client-id',
  gwSessionId: 'x-session-id',
  userId: 'x-user-id',
} as const satisfies Record<keyof RequestContext, string>

const FIELDS = Object.keys(TRACING_HEADERS) as (keyof RequestContext)[]

/** Values come from clients and end up in logs and in headers of our own outgoing calls. */
const MAX_VALUE_LENGTH = 128
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

const storage = new AsyncLocalStorage<RequestContext>()

type HeaderValue = string | readonly string[] | null | undefined

/**
 * Takes the five headers out of a request. A value that is empty, too long or not printable ASCII is
 * dropped as if it were absent: a header we forward must stay valid, and one fetch refuses would
 * turn a bad client value into a failed call to the agent. Nothing is made up: without
 * `x-trace-id` the request has no `rqUId`.
 */
export function readTracingContext(header: (name: string) => HeaderValue): RequestContext {
  const context: RequestContext = {}
  for (const field of FIELDS) {
    const raw = header(TRACING_HEADERS[field])
    const value = (typeof raw === 'string' ? raw : raw?.[0])?.trim()
    if (value && value.length <= MAX_VALUE_LENGTH && PRINTABLE_ASCII.test(value)) context[field] = value
  }
  return context
}

/**
 * Runs `fn` with `context` as the live context of everything it starts, asynchronous work included.
 * The object is not copied: `updateRequestContext` changes it for the whole scope.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function getRequestContext(): Readonly<RequestContext> {
  return storage.getStore() ?? {}
}

/** Adds what became known later, such as the account behind a token. Outside a request it does nothing. */
export function updateRequestContext(patch: RequestContext): void {
  const store = storage.getStore()
  if (store) Object.assign(store, patch)
}

/**
 * Keeps the current context for a function that runs later from outside it. Event emitters call
 * their listeners from the async context of the socket, not of the code that registered them, so a
 * WebSocket listener loses the request unless it is bound.
 */
export function bindRequestContext<F extends (...args: never[]) => unknown>(fn: F): F {
  return AsyncLocalStorage.bind(fn)
}

/**
 * All five headers with the current values, for every outgoing call. A missing value goes out
 * empty: the service downstream treats an empty header as an absent one.
 */
export function tracingHeaders(): Record<string, string> {
  const context = getRequestContext()
  return Object.fromEntries(FIELDS.map((field) => [TRACING_HEADERS[field], context[field] ?? '']))
}

/** The context as log fields: only what is set, so records outside a request stay as they were. */
export function requestContextLogFields(): RequestContext {
  return { ...getRequestContext() }
}
