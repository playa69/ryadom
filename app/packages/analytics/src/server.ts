import { randomUUID } from 'node:crypto'
import { PostHog } from 'posthog-node'
import type { AnalyticsAdmin } from './admin'
import { AnalyticsEvent, type AnalyticsEventArgs, type AnalyticsTraits, type TrafficType } from './events'
import { roundedToHour, sanitizeProperties, scrubErrorText } from './sanitize'

/**
 * The error as it is reported: the same name, the text made impersonal (what is quoted, addresses and mail
 * addresses replaced, short), and the frames as they are. An error of the server can carry a piece of what a
 * person sent (a bad JSON body is quoted by the parser), and the report must not.
 */
function impersonalError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  const safe = new Error(scrubErrorText(source.message))
  safe.name = source.name.replace(/[^A-Za-z0-9_.$ -]/g, '').slice(0, 80) || 'Error'
  const frames = (source.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
  safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join('\n')
  return safe
}

/**
 * Server-side analytics (services/api). The facts that change state are reported from here, because
 * the server cannot lose them to an ad blocker, a closed tab or a dropped connection.
 *
 * The contract with the rest of the code:
 * - Nothing here throws and nothing here waits. A report is queued in memory and sent in the
 *   background; if PostHog is down the report is lost, and the request that caused it is unaffected.
 * - Without a project key every method is a no-op, so the code needs no `if (analytics)` checks.
 * - People are identified by the account id only. The properties go through `sanitizeProperties`.
 */

/** The slice of the PostHog client that is used, so a test can hand in a stand-in. */
export interface ServerAnalyticsClient {
  capture(message: {
    distinctId: string
    event: string
    properties?: Record<string, unknown>
    disableGeoip?: boolean
    timestamp?: Date
  }): void
  identify(message: { distinctId: string; properties?: Record<string, unknown>; disableGeoip?: boolean }): void
  captureException(error: unknown, distinctId?: string, additionalProperties?: Record<string | number, unknown>): void
  shutdown(timeoutMs?: number): Promise<void>
  /** Sends what is queued without stopping. */
  flush?(): Promise<void>
  on?(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface ServerAnalyticsOptions {
  /** The PostHog project token. Empty: analytics are off. */
  key?: string | undefined
  /** The ingestion host, e.g. `https://eu.i.posthog.com`. */
  host: string
  /** `local` or `prod`: keeps local runs apart from prod in the one PostHog project. */
  appEnv: string
  /** Which service reports, e.g. `api`. */
  service: string
  /** Where a failure to deliver is reported. Never called with the data that failed. */
  onError?: (error: unknown) => void
  /** Erases people from PostHog when their account is deleted. Without it `erasePerson` reports `not_configured`. */
  admin?: AnalyticsAdmin | undefined
  /**
   * What the account says about being reported on: whether the person turned analytics off in their
   * profile, and whose traffic the account is. Asked before anything is reported about the person, and the
   * answer is remembered for `optOutTtlMs`. If the question cannot be answered the report is dropped, not
   * sent: for a person who may have said no, silence is the safe side.
   */
  accountState?: ((userId: string) => Promise<AccountAnalyticsState>) | undefined
  /** How long an answer of `accountState` is remembered. */
  optOutTtlMs?: number
  /** The build that reports (the image tag), sent as `app_version` so a figure can be split by release. */
  release?: string | undefined
  /** For tests. */
  client?: ServerAnalyticsClient
}

/** What an account says about being reported on (see `ServerAnalyticsOptions.accountState`). */
export interface AccountAnalyticsState {
  optOut: boolean
  trafficType: TrafficType
}

const REAL_PERSON: AccountAnalyticsState = { optOut: false, trafficType: 'real' }

/** The outcome of erasing a person: `not_configured` when no personal API key was given. */
export type ErasureResult = 'erased' | 'failed' | 'not_configured'

export interface ServerAnalytics {
  readonly enabled: boolean
  /** Whether people can be erased from PostHog (a personal API key is configured). */
  readonly canErase: boolean
  /** An event about a person. */
  capture<E extends AnalyticsEvent>(userId: string, event: E, ...args: AnalyticsEventArgs<E>): void
  /** An event about nobody: a random id and no person profile. For counts that must not point at a person. */
  captureAnonymous<E extends AnalyticsEvent>(event: E, ...args: AnalyticsEventArgs<E>): void
  /** Sets what is known about a person. */
  identify(userId: string, traits: AnalyticsTraits): void
  /** An error that was handled but is worth a look. */
  captureException(error: unknown, userId?: string, context?: object): void
  /**
   * Erases a person from PostHog, for an account that was deleted. It sends what is queued for the person first, so a
   * late event of this pod cannot bring the profile back, and settles when the erasure has been requested. It does
   * not wait and does not retry: the job `analytics.erase-person` (services/api/src/jobs/erase-person.ts) is queued
   * with the delay that lets the clients' own batches land, and retries a `failed` outcome.
   */
  erasePerson(userId: string): Promise<ErasureResult>
  /** Records a person's choice at once, so the next report already honours it (the answer is otherwise cached). */
  setOptOut(userId: string, optOut: boolean): void
  /** Sends what is queued. Called once on shutdown. */
  shutdown(): Promise<void>
}

const DISABLED: ServerAnalytics = {
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

/** Waiting for the queue on shutdown must fit in the pod's grace period (see lib/shutdown.ts). */
const SHUTDOWN_TIMEOUT_MS = 3_000
const DEFAULT_OPT_OUT_TTL_MS = 60_000
/** The remembered answers are bounded: the oldest is dropped past this many people. */
const MAX_REMEMBERED_PEOPLE = 10_000

export function createServerAnalytics(options: ServerAnalyticsOptions): ServerAnalytics {
  const { key, host, appEnv, service, onError } = options
  if (!key) return DISABLED

  const client: ServerAnalyticsClient =
    options.client ??
    (new PostHog(key, {
      host,
      flushAt: 20,
      flushInterval: 10_000,
      // The report is background work: a slow PostHog is given up on, not waited for.
      requestTimeout: 5_000,
      // The server's own address is meaningless as a place; so is a person's address, which we never send.
      disableGeoip: true,
      enableExceptionAutocapture: false,
    }) as unknown as ServerAnalyticsClient)

  client.on?.('error', (error) => onError?.(error))

  // `app_version` is the image tag of this build; without it the field is left out rather than guessed.
  const common = { app_env: appEnv, service, ...(options.release ? { app_version: options.release } : {}) }

  const safely = (action: () => void): void => {
    try {
      action()
    } catch (error) {
      onError?.(error)
    }
  }

  // ── What accounts said about being reported on ────────────────────────────────────────────
  const optOutTtl = options.optOutTtlMs ?? DEFAULT_OPT_OUT_TTL_MS
  const remembered = new Map<string, { state: AccountAnalyticsState; until: number }>()
  const asking = new Map<string, Promise<AccountAnalyticsState>>()

  const remember = (userId: string, state: AccountAnalyticsState): void => {
    if (!remembered.has(userId) && remembered.size >= MAX_REMEMBERED_PEOPLE) {
      const oldest = remembered.keys().next().value
      if (oldest !== undefined) remembered.delete(oldest)
    }
    remembered.set(userId, { state, until: Date.now() + optOutTtl })
  }

  /** The account's answer: remembered, or asked once however many reports wait on it. */
  const stateOf = (userId: string): AccountAnalyticsState | Promise<AccountAnalyticsState> => {
    const lookup = options.accountState
    if (!lookup) return REAL_PERSON
    const known = remembered.get(userId)
    if (known && known.until > Date.now()) return known.state
    let pending = asking.get(userId)
    if (!pending) {
      pending = lookup(userId)
        .then((answer) => {
          remember(userId, answer)
          return answer
        })
        .finally(() => asking.delete(userId))
      asking.set(userId, pending)
    }
    return pending
  }

  /**
   * Runs `send` for a person unless they opted out, with what the account says; a question that fails to be
   * answered drops the report.
   */
  const forPerson = (userId: string, send: (state: AccountAnalyticsState) => void): void => {
    const answer = stateOf(userId)
    if (!('then' in answer)) {
      if (!answer.optOut) safely(() => send(answer))
      return
    }
    answer.then((state) => (state.optOut ? undefined : safely(() => send(state))), (error: unknown) => onError?.(error))
  }

  // ── Erasing people ─────────────────────────────────────────────────────────────────────────
  const eraseNow = async (userId: string): Promise<ErasureResult> => {
    if (!options.admin) return 'not_configured'
    try {
      await client.flush?.()
      return (await options.admin.deletePerson(userId)) ? 'erased' : 'failed'
    } catch (error) {
      onError?.(error)
      return 'failed'
    }
  }

  return {
    enabled: true,
    canErase: options.admin !== undefined,
    erasePerson: eraseNow,
    setOptOut(userId, optOut) {
      const known = remembered.get(userId)
      if (optOut) remember(userId, { optOut: true, trafficType: known?.state.trafficType ?? 'real' })
      // Turning it back on: the traffic type of an account nobody asked about yet is not guessed, the next report asks.
      else if (known) remember(userId, { ...known.state, optOut: false })
      else remembered.delete(userId)
    },
    capture(userId, event, ...args) {
      forPerson(userId, (state) =>
        client.capture({
          distinctId: userId,
          event,
          properties: { ...sanitizeProperties(args[0]), ...common, traffic_type: state.trafficType },
          disableGeoip: true,
        }),
      )
    },
    captureAnonymous(event, ...args) {
      safely(() =>
        client.capture({
          distinctId: randomUUID(),
          event,
          properties: { ...sanitizeProperties(args[0]), ...common, $process_person_profile: false },
          disableGeoip: true,
          // Dated to the hour, so the minute of an event about nobody cannot be set beside the minute of
          // the same person's own activity (see `roundedToHour`).
          timestamp: roundedToHour(),
        }),
      )
    },
    identify(userId, traits) {
      // The traffic type is the account's, never the caller's: it is set here from what the account says.
      forPerson(userId, (state) =>
        client.identify({
          distinctId: userId,
          properties: { ...sanitizeProperties(traits), traffic_type: state.trafficType },
          disableGeoip: true,
        }),
      )
    },
    captureException(error, userId, context) {
      const send = () => client.captureException(impersonalError(error), userId, { ...sanitizeProperties(context), ...common })
      if (userId === undefined) safely(send)
      else forPerson(userId, send)
    },
    async shutdown() {
      // An erasure waits in the job queue, not here: it runs after the next start if this pod stops first.
      try {
        await client.shutdown(SHUTDOWN_TIMEOUT_MS)
      } catch (error) {
        onError?.(error)
      }
    },
  }
}
