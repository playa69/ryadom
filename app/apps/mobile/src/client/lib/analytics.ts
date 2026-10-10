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
import { MicrophoneDeniedError } from '@ryadom/client-core/voice/capture'

/**
 * Product analytics glue for this app: the mappings from what the screens know (an error, a route, a
 * platform) to the values of the event catalog, and the few reports that several screens share.
 *
 * What goes out is decided by the catalog (`@ryadom/analytics/events`): nothing here ever takes a
 * text, a name, an address or a length. Must not import platform-adapter.ts, api.ts or auth.ts, for the
 * same reason as app-update.ts (it is imported by the layer they sit on).
 */

/** The platform events are tagged with: a store build by its shell, the web build by how it was opened. */
export function analyticsPlatform(env: { android: boolean; ios: boolean; standalone: boolean }): AnalyticsPlatform {
  if (env.android) return 'android'
  if (env.ios) return 'ios'
  return env.standalone ? 'pwa' : 'web'
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
 * (`/journal/:dialogId/` -> `/journal/:id/`), the way the other apps name theirs. The pattern is used
 * and not the address, so that an identifier cannot get through by being in a shape nobody expected.
 */
export function screenPath(pattern: string | undefined): string | null {
  if (!pattern) return null
  return pattern.replace(/:[A-Za-z0-9_]+/g, ':id')
}

// ── Voice ───────────────────────────────────────────────────────────────────────────────────

/**
 * Why the microphone did not start. client-core collapses every `getUserMedia` failure into
 * `MicrophoneDeniedError`, so a missing microphone is told apart by the device list: a browser that
 * lists devices and has no input among them has no microphone. `audioInputs` is null when that is unknown.
 */
export function micFailureReason(error: unknown, audioInputs: number | null): VoiceProblemReason {
  if (!(error instanceof MicrophoneDeniedError)) return 'unsupported'
  return audioInputs === 0 ? 'no_microphone' : 'permission_denied'
}

/** How many audio inputs the browser lists; null when it lists nothing at all or cannot be asked. */
async function countAudioInputs(): Promise<number | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.length === 0 ? null : devices.filter((device) => device.kind === 'audioinput').length
  } catch {
    return null
  }
}

const reportedVoiceProblems = new Set<VoiceProblemReason>()

/** Once per reason and page load: someone who taps a broken microphone ten times is one problem, not ten. */
export function reportVoiceProblem(reason: VoiceProblemReason): void {
  if (reportedVoiceProblems.has(reason)) return
  reportedVoiceProblems.add(reason)
  track(AnalyticsEvent.VoiceProblem, { reason })
}

export async function reportMicFailure(error: unknown): Promise<void> {
  reportVoiceProblem(micFailureReason(error, await countAudioInputs()))
}

// ── Updates ─────────────────────────────────────────────────────────────────────────────────

const reportedUpdates = new Set<string>()

/**
 * An update event once per page load: the status check runs on every resume and the service worker
 * announces a waiting version more than once. `version` only tells releases apart here, it is not reported.
 */
export function reportAppUpdate(kind: AppUpdateKind, action: AppUpdateAction, version: string | number = ''): void {
  const key = `${kind}:${action}:${version}`
  if (reportedUpdates.has(key)) return
  reportedUpdates.add(key)
  track(AnalyticsEvent.AppUpdate, { kind, action })
}
