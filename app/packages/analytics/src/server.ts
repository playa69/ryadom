import { randomUUID } from 'node:crypto'
import { PostHog } from 'posthog-node'
import type { AnalyticsAdmin } from './admin'
import { AnalyticsEvent, type AnalyticsEventArgs, type AnalyticsTraits } from './events'
import { sanitizeProperties } from './sanitize'

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
  capture(message: { distinctId: string; event: string; properties?: Record<string, unknown>; disableGeoip?: boolean }): void
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
   * Erases a person and their history from PostHog, for an account that was just deleted. What is
   * still queued for them is sent first, so a late event cannot bring the profile back.
   */
  erasePerson(userId: string): Promise<ErasureResult>
  /** Sends what is queued. Called once on shutdown. */
  shutdown(): Promise<void>
}

const DISABLED: ServerAnalytics = {
  enabled: false,
  canErase: false,
  erasePerson: async () => 'not_configured',
  capture() {},
  captureAnonymous() {},
  identify() {},
  isFeatureEnabled: async () => false,
  captureException() {},
  shutdown: async () => {},
}

/** Waiting for the queue on shutdown must fit in the pod's grace period (see lib/shutdown.ts). */
const SHUTDOWN_TIMEOUT_MS = 3_000

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

  return {
    enabled: true,
    canErase: options.admin !== undefined,
    async erasePerson(userId) {
      if (!options.admin) return 'not_configured'
      try {
        await client.flush?.()
        return (await options.admin.deletePerson(userId)) ? 'erased' : 'failed'
      } catch (error) {
        onError?.(error)
        return 'failed'
      }
    },
    capture(userId, event, ...args) {
      safely(() =>
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
        }),
      )
    },
    identify(userId, traits) {
      safely(() =>
        client.identify({ distinctId: userId, properties: sanitizeProperties(traits), disableGeoip: true }),
      )
    },
    async isFeatureEnabled(flag, userId) {
      try {
        return (await client.isFeatureEnabled(flag, userId)) === true
      } catch (error) {
        onError?.(error)
        return false
      }
    },
    captureException(error, userId, context) {
      safely(() =>
        client.captureException(error, userId, { ...sanitizeProperties(context), ...common }),
      )
    },
    async shutdown() {
      try {
        await client.shutdown(SHUTDOWN_TIMEOUT_MS)
      } catch (error) {
        onError?.(error)
      }
    },
  }
}
