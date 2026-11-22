import { track } from '@ryadom/analytics/browser'
import {
  AnalyticsEvent,
  formOutcomeFromCode,
  formOutcomeFromStatus,
  type AnalyticsPlatform,
  type AppUpdateAction,
  type AppUpdateKind,
  type AuthForm,
  type FormOutcome,
  type VoiceProblemReason,
} from '@ryadom/analytics/events'
import { ApiError } from '@ryadom/client-core/errors'
import { MicrophoneDeniedError, MicrophoneNotFoundError } from '@ryadom/client-core/voice/capture'

/**
 * Product analytics glue for this app: the mappings from what the screens know (an error, a route, a
 * platform) to the values of the event catalog, and the few reports that several screens share.
 *
 * What goes out is decided by the catalog (`@ryadom/analytics/events`): nothing here ever takes a
 * text, a name, an address or a length. Must not import platform-adapter.ts, api.ts or auth.ts, for the
 * same reason as app-update.ts (it is imported by the layer they sit on).
 */

/** The platform events are tagged with: a store build by its shell, the web build by how it was opened. */
export function analyticsPlatform(env: {
  android: boolean
  ios: boolean
  standalone: boolean
  telegram?: boolean
}): AnalyticsPlatform {
  if (env.android) return 'android'
  if (env.ios) return 'ios'
  if (env.telegram) return 'telegram'
  return env.standalone ? 'pwa' : 'web'
}

/**
 * The address under which this app's screens are reported to Yandex Metrika (`pageBase` of `startAnalytics`).
 * Framework7 does not change the address bar, so the PWA's address is always its start page; the WebView of a
 * store build is `localhost`, which the counter does not accept. So the screens are reported under the site's
 * origin and a prefix of the surface: the PWA and Telegram under the prefix the PWA is published at (`/pwa`: that is
 * how the cabinet's goal "Переход в продукт" recognises the product), the store builds under `/android` and `/ios`.
 * No trailing slash.
 */
export function metrikaPageBase(env: {
  platform: AnalyticsPlatform
  /** `getApiBase()`: absolute in a store build, empty for the web build. */
  apiBase: string
  /** The page's own origin. */
  origin: string
  /** `import.meta.env.BASE_URL`: `/pwa/` for the web build, `/` in a store build. */
  baseUrl: string
}): string {
  if (env.platform === 'android' || env.platform === 'ios') {
    return `${siteOrigin(env.apiBase, env.origin)}/${env.platform}`
  }
  return `${env.origin}${env.baseUrl.replace(/\/+$/, '')}`
}

/** The site's origin: the API's, which lives on the same host as the site, or the page's own when it is relative. */
function siteOrigin(apiBase: string, fallback: string): string {
  try {
    return new URL(apiBase).origin
  } catch {
    return fallback
  }
}

// ── Forms ───────────────────────────────────────────────────────────────────────────────────

/**
 * What a thrown API error means for a form. The mapping of statuses is shared by every client
 * (`formOutcomeFromStatus`); an error that is not an API answer at all is an `error`.
 */
export function outcomeFromError(error: unknown): FormOutcome {
  return error instanceof ApiError ? formOutcomeFromStatus(error.status) : 'error'
}

/** What a rule named by the server (a 200 with `ok: false`) means for a form. */
export function outcomeFromCode(code: string): FormOutcome {
  return formOutcomeFromCode(code)
}

export function reportForm(form: AuthForm, outcome: FormOutcome): void {
  track(AnalyticsEvent.AuthFormSubmitted, { form, outcome })
}

// ── Screens ─────────────────────────────────────────────────────────────────────────────────

/**
 * The name of a screen from a route pattern, with every parameter called `:id`
 * (`/diary/journal/:dialogId/` -> `/diary/journal/:id/`), the way the other apps name theirs. The pattern is used
 * and not the address, so that an identifier cannot get through by being in a shape nobody expected.
 */
export function screenPath(pattern: string | undefined): string | null {
  if (!pattern) return null
  return pattern.replace(/:[A-Za-z0-9_]+/g, ':id')
}

// ── Voice ───────────────────────────────────────────────────────────────────────────────────

/** Browser permission decisions and absent inputs are reported separately. */
export function micFailureReason(error: unknown): VoiceProblemReason {
  if (error instanceof MicrophoneDeniedError) return 'permission_denied'
  if (error instanceof MicrophoneNotFoundError) return 'no_microphone'
  return 'unsupported'
}

const reportedVoiceProblems = new Set<VoiceProblemReason>()

/** Once per reason and page load: someone who taps a broken microphone ten times is one problem, not ten. */
export function reportVoiceProblem(reason: VoiceProblemReason): void {
  if (reportedVoiceProblems.has(reason)) return
  reportedVoiceProblems.add(reason)
  track(AnalyticsEvent.VoiceProblem, { reason })
}

export function reportMicFailure(error: unknown): void {
  reportVoiceProblem(micFailureReason(error))
}

// ── Updates ─────────────────────────────────────────────────────────────────────────────────

const reportedUpdates = new Set<string>()

/**
 * An update event once per page load: the status check runs on every resume and the service worker
 * announces a waiting version more than once. `version` only tells releases apart here, it is not reported.
 */
export function reportAppUpdate(
  kind: AppUpdateKind,
  action: AppUpdateAction,
  version: string | number = '',
): void {
  const key = `${kind}:${action}:${version}`
  if (reportedUpdates.has(key)) return
  reportedUpdates.add(key)
  track(AnalyticsEvent.AppUpdate, { kind, action })
}
