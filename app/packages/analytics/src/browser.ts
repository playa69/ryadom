import type { PostHog, PostHogConfig } from 'posthog-js'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import type { ApiEnvelope } from '@ryadom/contracts/api/envelope'
import { ApiPath } from '@ryadom/contracts/api/paths'
import type { AnalyticsEvent, AnalyticsEventArgs, AnalyticsPlatform, AnalyticsTraits } from './events'
import { normalizePath, roundedToHour, sanitizeProperties, scrubEvent } from './sanitize'

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
 * 4. **Nothing personal.** Cookies are not used, click capture reports the structure of the page, never
 *    its text (`mask_all_text`, and `scrubEvent` cuts what is left), there is no session replay, no
 *    heatmaps and no feature flags, URLs are stripped of query strings and ids, and every property passes
 *    `sanitizeProperties`. Elements that carry the `ph-no-capture` class (SOS, hotlines, screens with a
 *    conversation) are never captured.
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
/**
 * The properties every event carries (platform, version, environment). The SDK keeps them as super properties,
 * but `posthog.reset()` (sign-out) wipes those, and events after it lost them: they are put back in `before_send`.
 */
let commonProperties: Record<string, string> = {}
const queue: Array<(posthog: PostHog) => void> = []
const MAX_QUEUE = 50

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

/**
 * Elements (and everything inside them) that click capture, dead clicks and rage clicks never look at.
 * `ph-no-capture` is put by hand on SOS, hotlines and screens with a conversation; the rest are the
 * overlays that are drawn outside the screen that opened them (a Radix dialog is a portal in `body`, a
 * Framework7 dialog, sheet or popup sits at the root of the app), where a tap is just as much about a
 * person: a confirmation of deleting an account, an alert about the microphone. Giving a list replaces the
 * SDK's own defaults, so those are repeated here.
 */
export const NEVER_CAPTURE = [
  '.ph-no-capture',
  '.ph-no-autocapture',
  '[data-ph-no-autocapture]',
  '.ph-no-deadclick',
  '.ph-no-rageclick',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '.dialog',
  '.sheet-modal',
  '.popup',
  '.popover',
  '.actions-modal',
  // The dimmed area behind a sheet or a dialog: a tap beside the SOS sheet is still a tap in the SOS sheet.
  '.sheet-backdrop',
  '.popup-backdrop',
  '.actions-backdrop',
  '.dialog-backdrop',
  '.popover-backdrop',
]

/**
 * The SDK's settings. Exported so a test can pin them down. What is collected is fixed here and not taken
 * from the server: `config.features` is there only for clients shipped before that (see the contract).
 *
 * Above every option stands its legal risk under Russian law, in short ("Legal risk"). A research summary
 * from 2026-10-10, not a lawyer's opinion; sources and detail in docs/analytics.md ("Правовые риски").
 * What is true of every option: events with an account id stay personal data of the operator (152-FZ
 * art. 3 p. 1, 9, art. 13.1: "depersonalised" is not "not personal data"); they go to a processor abroad
 * (cross-border transfer, art. 12: notify Roskomnadzor before it starts) through our proxy straight into a
 * foreign database (localisation, art. 18 part 5); and the opt-out switch is not consent (art. 9).
 */
export function buildSdkConfig(config: AnalyticsConfigApiResponse, apiBase: string): Partial<PostHogConfig> {
  return {
    // The proxy, not a PostHog host: see ingest-proxy.ts.
    api_host: `${apiBase}${ApiPath.Ingest}`,
    ui_host: config.uiHost,
    // A person gets a profile only once they sign in; before that, events are anonymous and cheap.
    // Legal risk, LOW: it keeps the visitor of the site out of person profiles; after sign-in the profile
    // is the account id, a pseudonym that points at a person through our database.
    person_profiles: 'identified_only',
    // No cookies: localStorage is enough for one app on one origin, and needs no cookie banner.
    // Legal risk, LOW-MEDIUM: a stable identifier on the device is personal data in the Roskomnadzor's view
    // (it said so of cookies; nothing found on localStorage), so the policy must say it exists and how to
    // refuse. In the EU the ePrivacy rules treat local storage like a cookie and usually ask for consent.
    persistence: 'localStorage',
    // Legal risk, reduces it: a browser that says "do not track" reports nothing.
    respect_dnt: true,
    // Legal risk, reduces it: advertising click ids that the SDK copies from the address are replaced with
    // `<masked>` by the SDK itself (and removed by `scrubEvent`, which also knows `$session_entry_*`).
    mask_personal_data_properties: true,
    // The address of the person is not sent (the proxy drops it as well).
    // Legal risk, reduces it: the address is personal data, and it stops at our proxy.
    ip: false,
    // Page views are sent by the app itself, with the route and not the address, see `trackPageview`.
    capture_pageview: false,
    // How long a screen was open and how far it was scrolled; the address in it is scrubbed like any other.
    // Legal risk, LOW: behaviour data tied to the account id (art. 5 parts 1-2, proportionality).
    capture_pageleave: true,
    // Clicks are the structure of the page: the SDK is told to leave the text out, and `scrubEvent`
    // cuts what is left (text, links, ids, labels) in case a setting changes in a later version.
    // Legal risk, MEDIUM: clicks tied to the account id describe behaviour in detail. If the scrubbing ever
    // lets an element's text through, it is page content, and on conversation and profile screens data about
    // the person's state (art. 10: written consent, higher fines). SOS, hotlines and screens with content
    // carry `ph-no-capture`; every new crisis-path button must carry it too.
    autocapture: { dom_event_allowlist: ['click'], capture_copied_text: false, css_selector_ignorelist: NEVER_CAPTURE },
    // Legal risk, reduces it: no element text leaves the device.
    mask_all_text: true,
    mask_all_element_attributes: false,
    // Legal risk, MEDIUM: the same as `autocapture` (dead clicks carry the same element data).
    capture_dead_clicks: { css_selector_ignorelist: NEVER_CAPTURE },
    // Rage clicks are part of click capture, and ignore the same elements.
    rageclick: { css_selector_ignorelist: NEVER_CAPTURE },
    // Off, and explicitly so: the project-level switch in PostHog is on, and the SDK would follow it. The SDK
    // takes clicks and mouse moves at the `document` in the capture phase and knows nothing of `ph-no-capture`,
    // so a tap on SOS or on a hotline would become a point under the account id and defeat `trackAnonymous`
    // for the crisis path.
    capture_heatmaps: false,
    // Legal risk, LOW-MEDIUM: an error's text and stack could hold page data (a name, typed text in an engine
    // message, a secret code in a frame's file address), art. 5 part 5 (minimisation); `scrubEvent` makes the
    // text impersonal (quoted pieces, addresses and mail addresses replaced, 80 characters) and scrubs frames.
    capture_exceptions: true,
    // No attribution: it names the element and the resource that were slowest, which is page content.
    // Legal risk, LOW: load timings and device data.
    capture_performance: { web_vitals: true, web_vitals_attribution: false },
    // Off: a recording of behaviour on screen is the largest processing there is. Even masked it shows layout,
    // pauses and taps on screens with personal content, possibly the person's state (art. 10).
    disable_session_recording: true,
    // Off: the product has no flags, and the request for them goes around `before_send` carrying the stored
    // initial properties of the person (full entry address with its query, referrer, account id, device id,
    // time zone).
    advanced_disable_flags: true,
    // Nothing the product does not use is loaded. Surveys are not used: a pop-up with a question in
    // the middle of someone's bad day is not something this product does.
    disable_surveys: true,
    disable_web_experiments: true,
    disable_product_tours: true,
    disable_conversations: true,
    opt_out_capturing_by_default: readStoredOptOut(),
    before_send: (event) => scrubEvent(withCommonProperties(event)),
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
      commonProperties = {
        app_platform: options.platform,
        app_version: options.appVersion ?? '',
        app_env: config.environment,
      }
      posthog.register({
        app_platform: options.platform,
        app_version: options.appVersion,
        app_env: config.environment,
        // Our proxy is what PostHog sees, so its location would be the place of every person: the server's.
        // The person's own time zone and language already travel with each event.
        $geoip_disable: true,
      })

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

/** Fills in the common properties an event came without, e.g. after `reset()`; ones it already has are kept. */
function withCommonProperties<T extends { properties?: Record<string, unknown> | undefined }>(event: T | null): T | null {
  if (!event) return event
  const properties = event.properties ?? (event.properties = {})
  for (const [key, value] of Object.entries(commonProperties)) {
    if (value !== '' && properties[key] === undefined) properties[key] = value
  }
  return event
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
      // Dated to the hour: to the minute, an event about nobody could be matched to the same person's
      // other events made at that minute.
      timestamp: roundedToHour().toISOString(),
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

/** For tests: back to a fresh page load. */
export function resetAnalyticsForTests(): void {
  status = 'idle'
  client = null
  starting = null
  anonymousChannel = null
  commonProperties = {}
  queue.length = 0
  optOutListeners.clear()
}
