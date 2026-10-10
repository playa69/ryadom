import type { PostHog, PostHogConfig } from 'posthog-js'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import type { ApiEnvelope } from '@ryadom/contracts/api/envelope'
import { ApiPath } from '@ryadom/contracts/api/paths'
import type { AnalyticsEvent, AnalyticsEventArgs, AnalyticsPlatform, AnalyticsTraits } from './events'
import { normalizePath, sanitizeProperties, scrubEvent } from './sanitize'

/**
 * Product analytics in the browser and in the store builds' WebView: one module for the web app, the
 * PWA, the landing and the Capacitor builds.
 *
 * How it behaves, in order of what matters:
 *
 * 1. **Nothing happens until the server says so.** `startAnalytics` asks the API what is switched on
 *    (`GET /api/analytics/config`) and only then loads the SDK. No key, or a failed request, means
 *    analytics stay off for this launch and no code of PostHog is even downloaded.
 * 2. **Calls made before that are not lost.** `track`, `identify` and the rest queue (a few dozen at
 *    most) until the SDK is ready, and are dropped if analytics turn out to be off. A call site never
 *    has to ask "is it ready?".
 * 3. **Everything goes through our reverse proxy** (`/api/ingest`), never to a PostHog host.
 * 4. **Nothing personal.** Cookies are not used, autocapture is off unless the server turns it on,
 *    session replay is off unless the server turns it on and then masks all text and inputs, URLs are
 *    stripped of query strings and ids, and every property passes `sanitizeProperties`.
 * 5. **The person can opt out** (`setAnalyticsOptOut`), and a browser's Do Not Track is honoured.
 *
 * Nothing here throws: a failure of analytics must never become a failure of the app.
 */

type Status = 'idle' | 'starting' | 'ready' | 'disabled'

let status: Status = 'idle'
let client: PostHog | null = null
let starting: Promise<boolean> | null = null
/** What `trackAnonymous` needs after startup: it bypasses the SDK, so it has to know where and as whom to send. */
let anonymousChannel: { url: string; key: string; common: Record<string, string> } | null = null
const queue: Array<(posthog: PostHog) => void> = []
const MAX_QUEUE = 50

const flagListeners = new Set<() => void>()
const optOutListeners = new Set<() => void>()

const OPT_OUT_KEY = 'ryadom.analytics.optout'
const CONFIG_TIMEOUT_MS = 5_000

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // Analytics must not break the screen it is measuring.
  }
}

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) safely(listener)
}

// ── Opt-out ─────────────────────────────────────────────────────────────────────────────────

function readStoredOptOut(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPT_OUT_KEY) === '1'
  } catch {
    return false
  }
}

/** Whether the person has turned analytics off on this device. */
export function isAnalyticsOptedOut(): boolean {
  return readStoredOptOut()
}

/** Turns reporting off (or back on) on this device. Takes effect at once and survives a restart. */
export function setAnalyticsOptOut(optOut: boolean): void {
  try {
    if (optOut) globalThis.localStorage?.setItem(OPT_OUT_KEY, '1')
    else globalThis.localStorage?.removeItem(OPT_OUT_KEY)
  } catch {
    // Storage may be blocked; the SDK's own flag below still applies for this session.
  }
  whenReady((posthog) => (optOut ? posthog.opt_out_capturing() : posthog.opt_in_capturing()))
  notify(optOutListeners)
}

/**
 * Brings the device's choice and the account's choice together after sign-in. A "no" wins wherever it
 * was said: opted out on another device, this device follows; opted out here before the account
 * existed (or while signed out), the account is told. Turning analytics back on is a deliberate act
 * that changes both (`setAnalyticsOptOut(false)` and the profile call), never a side effect of this.
 *
 * `tellServer` failing is not an error here: the device has already stopped reporting, and the next
 * sign-in tries again.
 */
export async function reconcileOptOut(
  serverOptOut: boolean,
  tellServer: (optOut: boolean) => Promise<unknown>,
): Promise<void> {
  const local = isAnalyticsOptedOut()
  if (serverOptOut && !local) setAnalyticsOptOut(true)
  else if (local && !serverOptOut) await tellServer(true).catch(() => {})
}

export function subscribeAnalyticsOptOut(listener: () => void): () => void {
  optOutListeners.add(listener)
  return () => optOutListeners.delete(listener)
}

// ── Startup ─────────────────────────────────────────────────────────────────────────────────

/** Reads what the server has switched on. Null on any failure: the answer to "should I report?" is then no. */
export async function loadAnalyticsConfig(
  apiBase: string,
  doFetch: typeof fetch = fetch,
): Promise<AnalyticsConfigApiResponse | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS)
  try {
    const response = await doFetch(`${apiBase}${ApiPath.AnalyticsConfig}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const envelope = (await response.json()) as ApiEnvelope<AnalyticsConfigApiResponse>
    return envelope.status ? envelope.result : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface StartAnalyticsOptions {
  /** The API origin, no trailing slash; an empty string means the page's own origin. */
  apiBase: string
  platform: AnalyticsPlatform
  appVersion?: string | undefined
  /** For tests. */
  fetch?: typeof fetch
  /** For tests: how the SDK is loaded. */
  loadSdk?: () => Promise<PostHog>
}

async function defaultLoadSdk(): Promise<PostHog> {
  return (await import('posthog-js')).default
}

/** The SDK's settings for a server-provided configuration. Exported so a test can pin them down. */
export function buildSdkConfig(config: AnalyticsConfigApiResponse, apiBase: string): Partial<PostHogConfig> {
  const { features } = config
  return {
    // The proxy, not a PostHog host: see ingest-proxy.ts.
    api_host: `${apiBase}${ApiPath.Ingest}`,
    ui_host: config.uiHost,
    // A person gets a profile only once they sign in; before that, events are anonymous and cheap.
    person_profiles: 'identified_only',
    // No cookies: localStorage is enough for one app on one origin, and needs no cookie banner.
    persistence: 'localStorage',
    respect_dnt: true,
    // The address of the person is not sent (the proxy drops it as well).
    ip: false,
    // Page views are sent by the app itself, with the route and not the address, see `trackPageview`.
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: features.autocapture,
    capture_dead_clicks: false,
    // Explicit either way: the project-level switch in PostHog is on, and the SDK would follow it.
    capture_heatmaps: features.heatmaps,
    capture_exceptions: features.errorTracking,
    capture_performance: features.webVitals ? { web_vitals: true } : false,
    disable_session_recording: !features.sessionReplay,
    session_recording: {
      // A replay shows the layout and the taps and nothing that was written or said.
      maskAllInputs: true,
      maskTextSelector: '*',
      blockSelector: '[data-ph-block]',
      recordCrossOriginIframes: false,
    },
    disable_surveys: !features.surveys,
    advanced_disable_flags: !features.featureFlags,
    // Nothing the product does not use is loaded.
    disable_web_experiments: true,
    disable_product_tours: true,
    disable_conversations: true,
    opt_out_capturing_by_default: readStoredOptOut(),
    before_send: (event) => scrubEvent(event),
  }
}

/**
 * Starts analytics once per page load; later calls return the first one's result. Resolves to
 * whether reporting is on. Call it without awaiting: the app does not wait for analytics.
 */
export function startAnalytics(options: StartAnalyticsOptions): Promise<boolean> {
  if (starting) return starting
  status = 'starting'
  starting = (async () => {
    try {
      const config = await loadAnalyticsConfig(options.apiBase, options.fetch)
      if (!config?.enabled || !config.key) return turnOff()

      const posthog = await (options.loadSdk ?? defaultLoadSdk)()
      posthog.init(config.key, buildSdkConfig(config, options.apiBase))
      posthog.register({
        app_platform: options.platform,
        app_version: options.appVersion,
        app_env: config.environment,
      })
      posthog.onFeatureFlags(() => notify(flagListeners))

      anonymousChannel = {
        url: `${options.apiBase}${ApiPath.Ingest}/e/?ip=0`,
        key: config.key,
        common: {
          app_platform: options.platform,
          app_version: options.appVersion ?? '',
          app_env: config.environment,
        },
      }
      client = posthog
      status = 'ready'
      // Calls made while the SDK was loading, in their original order.
      for (const action of queue.splice(0)) safely(() => action(posthog))
      return true
    } catch {
      return turnOff()
    }
  })()
  return starting
}

function turnOff(): false {
  status = 'disabled'
  queue.length = 0
  return false
}

function whenReady(action: (posthog: PostHog) => void): void {
  if (status === 'disabled') return
  if (status === 'ready' && client) {
    const posthog = client
    safely(() => action(posthog))
    return
  }
  if (queue.length < MAX_QUEUE) queue.push(action)
}

// ── Reporting ───────────────────────────────────────────────────────────────────────────────

/** Reports an event from the catalog. The properties are checked by the compiler and cleaned at run time. */
export function track<E extends AnalyticsEvent>(event: E, ...args: AnalyticsEventArgs<E>): void {
  const properties = sanitizeProperties(args[0])
  whenReady((posthog) => posthog.capture(event, properties))
}

/**
 * An event about nobody: for counts that must not point at a person (the SOS screen, a tap on a
 * hotline). It does not go through the SDK, because the SDK attaches every event to the signed-in
 * person; it is a single request with a random id used once, no profile, nothing stored on the
 * device. Respects the person's opt-out and the browser's Do Not Track like everything else.
 */
export function trackAnonymous<E extends AnalyticsEvent>(event: E, ...args: AnalyticsEventArgs<E>): void {
  const properties = sanitizeProperties(args[0])
  whenReady(() => {
    if (!anonymousChannel || isAnalyticsOptedOut() || doNotTrackEnabled()) return
    const body = JSON.stringify({
      api_key: anonymousChannel.key,
      event,
      distinct_id: randomId(),
      properties: { ...properties, ...anonymousChannel.common, $process_person_profile: false, $geoip_disable: true },
    })
    void fetch(anonymousChannel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
      credentials: 'omit',
      // The tap may be followed at once by leaving the page (a call starts).
      keepalive: true,
    }).catch(() => {})
  })
}

function doNotTrackEnabled(): boolean {
  const nav = globalThis.navigator as (Navigator & { msDoNotTrack?: string }) | undefined
  return nav?.doNotTrack === '1' || nav?.msDoNotTrack === '1'
}

function randomId(): string {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/**
 * A screen was shown. `path` is the route (`/dialog/abc` is reported as `/dialog/:id`); without it
 * the current location is used. The page's query string and fragment are never reported.
 */
export function trackPageview(path?: string): void {
  const route = normalizePath(path ?? globalThis.location?.pathname ?? '/')
  whenReady((posthog) =>
    posthog.capture('$pageview', { $current_url: `${globalThis.location?.origin ?? ''}${route}`, screen: route }),
  )
}

/** The person signed in (or the session was restored). The id is the account's, never the email. */
export function identify(userId: string, traits?: AnalyticsTraits): void {
  const clean = sanitizeProperties(traits)
  whenReady((posthog) => posthog.identify(userId, clean))
}

/** The person signed out: the next events belong to nobody until they sign in again. */
export function resetIdentity(): void {
  whenReady((posthog) => posthog.reset())
}

/** An error the app caught but wants to see. Unhandled ones are reported by the SDK itself. */
export function captureError(error: unknown, context?: object): void {
  const clean = sanitizeProperties(context)
  whenReady((posthog) => posthog.captureException(error, clean))
}

// ── Feature flags ───────────────────────────────────────────────────────────────────────────

/** The value of a flag for this person; undefined while flags have not loaded or analytics are off. */
export function getFeatureFlag(flag: string): string | boolean | undefined {
  if (status !== 'ready' || !client) return undefined
  try {
    return client.getFeatureFlag(flag)
  } catch {
    return undefined
  }
}

export function isFeatureEnabled(flag: string): boolean | undefined {
  if (status !== 'ready' || !client) return undefined
  try {
    return client.isFeatureEnabled(flag)
  } catch {
    return undefined
  }
}

/** Called whenever the flags change (they load after the SDK does, and again after `identify`). */
export function subscribeFeatureFlags(listener: () => void): () => void {
  flagListeners.add(listener)
  return () => flagListeners.delete(listener)
}

/** For tests: back to a fresh page load. */
export function resetAnalyticsForTests(): void {
  status = 'idle'
  client = null
  starting = null
  anonymousChannel = null
  queue.length = 0
  flagListeners.clear()
  optOutListeners.clear()
}
