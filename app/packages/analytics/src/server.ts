import { randomUUID } from 'node:crypto'
import { PostHog } from 'posthog-node'
import type { AnalyticsAdmin } from './admin'
import { AnalyticsEvent, type AnalyticsEventArgs, type AnalyticsTraits } from './events'
import { roundedToHour, sanitizeProperties } from './sanitize'

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
  isFeatureEnabled(key: string, distinctId: string): Promise<boolean | undefined>
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
  /** `local`, `staging` or `prod`: lets one PostHog project hold more than one environment. */
  appEnv: string
  /** Which service reports, e.g. `api`. */
  service: string
  /** Where a failure to deliver is reported. Never called with the data that failed. */
  onError?: (error: unknown) => void
  /** Erases people from PostHog when their account is deleted. Without it `erasePerson` reports `not_configured`. */
  admin?: AnalyticsAdmin | undefined
  /**
   * Whether a person has turned analytics off in their profile. Asked before anything is reported
   * about them, and the answer is remembered for `optOutTtlMs`. If the question cannot be answered the
   * report is dropped, not sent: for a person who may have said no, silence is the safe side.
   */
  isOptedOut?: ((userId: string) => Promise<boolean>) | undefined
  /** How long an answer of `isOptedOut` is remembered. */
  optOutTtlMs?: number
  /**
   * How long `erasePerson` waits before asking PostHog to erase. The clients batch their events and
   * send them a few seconds later; erasing at once would let a batch that was queued before the
   * deletion arrive after it and create the person again. Pending erasures run at once on `shutdown`.
   */
  erasureDelayMs?: number
  /** For tests. */
  client?: ServerAnalyticsClient
}

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
  /** A feature flag for a person; false when analytics are off or PostHog does not answer. */
  isFeatureEnabled(flag: string, userId: string): Promise<boolean>
  /** An error that was handled but is worth a look. */
  captureException(error: unknown, userId?: string, context?: object): void
  /**
   * Erases a person from PostHog, for an account that was just deleted. It waits `erasureDelayMs`
   * first (see the option) and sends what is queued for the person, so a late event cannot bring the
   * profile back; the promise settles when the erasure has been requested.
   */
  erasePerson(userId: string): Promise<ErasureResult>
  /** Records a person's choice at once, so the next report already honours it (the answer is otherwise cached). */
  setOptOut(userId: string, optOut: boolean): void
  /** Sends what is queued and runs pending erasures. Called once on shutdown. */
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
  isFeatureEnabled: async () => false,
  captureException() {},
  shutdown: async () => {},
}

/** Waiting for the queue on shutdown must fit in the pod's grace period (see lib/shutdown.ts). */
const SHUTDOWN_TIMEOUT_MS = 3_000
const DEFAULT_OPT_OUT_TTL_MS = 60_000
const DEFAULT_ERASURE_DELAY_MS = 30_000
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

  const common = { app_env: appEnv, service }

  const safely = (action: () => void): void => {
    try {
      action()
    } catch (error) {
      onError?.(error)
    }
  }

  // ── What people said about being reported on ──────────────────────────────────────────────
  const optOutTtl = options.optOutTtlMs ?? DEFAULT_OPT_OUT_TTL_MS
  const remembered = new Map<string, { optOut: boolean; until: number }>()
  const asking = new Map<string, Promise<boolean>>()

  const remember = (userId: string, optOut: boolean): void => {
    if (!remembered.has(userId) && remembered.size >= MAX_REMEMBERED_PEOPLE) {
      const oldest = remembered.keys().next().value
      if (oldest !== undefined) remembered.delete(oldest)
    }
    remembered.set(userId, { optOut, until: Date.now() + optOutTtl })
  }

  /** The person's answer: remembered, or asked once however many reports wait on it. */
  const optedOut = (userId: string): boolean | Promise<boolean> => {
    const lookup = options.isOptedOut
    if (!lookup) return false
    const known = remembered.get(userId)
    if (known && known.until > Date.now()) return known.optOut
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

  /** Runs `send` for a person unless they opted out; a question that fails to be answered drops the report. */
  const forPerson = (userId: string, send: () => void): void => {
    const answer = optedOut(userId)
    if (typeof answer === 'boolean') {
      if (!answer) safely(send)
      return
    }
    answer.then((out) => (out ? undefined : safely(send)), (error: unknown) => onError?.(error))
  }

  // ── Erasing people ─────────────────────────────────────────────────────────────────────────
  const erasureDelay = options.erasureDelayMs ?? DEFAULT_ERASURE_DELAY_MS
  const pendingErasures = new Set<() => Promise<void>>()

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
    erasePerson(userId) {
      if (!options.admin) return Promise.resolve('not_configured')
      if (erasureDelay <= 0) return eraseNow(userId)
      return new Promise<ErasureResult>((resolve) => {
        let started = false
        const run = async (): Promise<void> => {
          if (started) return
          started = true
          clearTimeout(timer)
          pendingErasures.delete(run)
          resolve(await eraseNow(userId))
        }
        const timer = setTimeout(() => void run(), erasureDelay)
        // The timer alone must not keep the process alive; `shutdown` runs what is still waiting.
        timer.unref?.()
        pendingErasures.add(run)
      })
    },
    setOptOut(userId, optOut) {
      remember(userId, optOut)
    },
    capture(userId, event, ...args) {
      forPerson(userId, () =>
        client.capture({
          distinctId: userId,
          event,
          properties: { ...sanitizeProperties(args[0]), ...common },
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
      forPerson(userId, () =>
        client.identify({ distinctId: userId, properties: sanitizeProperties(traits), disableGeoip: true }),
      )
    },
    async isFeatureEnabled(flag, userId) {
      try {
        // A person who said no is not asked about for flags either: that request names them to PostHog.
        if (await optedOut(userId)) return false
        return (await client.isFeatureEnabled(flag, userId)) === true
      } catch (error) {
        onError?.(error)
        return false
      }
    },
    captureException(error, userId, context) {
      const send = () => client.captureException(error, userId, { ...sanitizeProperties(context), ...common })
      if (userId === undefined) safely(send)
      else forPerson(userId, send)
    },
    async shutdown() {
      // Erasures that were waiting for the clients' queues run now: the process will not be here later.
      await Promise.allSettled([...pendingErasures].map((run) => run()))
      try {
        await client.shutdown(SHUTDOWN_TIMEOUT_MS)
      } catch (error) {
        onError?.(error)
      }
    },
  }
}
