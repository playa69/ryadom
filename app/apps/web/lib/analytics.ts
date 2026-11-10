import { useEffect, useRef } from 'react'
import { track } from '@ryadom/analytics/browser'
import {
  AnalyticsEvent,
  formOutcomeFromCode,
  formOutcomeFromStatus,
  type AuthForm,
  type FormOutcome,
  type VoiceProblemDetail,
  type VoiceProblemReason,
} from '@ryadom/analytics/events'
import { ApiError } from '@ryadom/client-core/errors'
import { MicrophoneDeniedError, MicrophoneError } from '@ryadom/client-core/voice/capture'

/**
 * The small pieces the screens share to report what only the screen knows. The events themselves are
 * the catalog's (`@ryadom/analytics/events`); nothing here ever takes a piece of text: a form reports
 * which form and how it ended, never what was typed.
 */

/**
 * How a form ended, from the error its request threw. The mapping of statuses is shared by every
 * client (`formOutcomeFromStatus`); an error that is not an API answer at all (no connection, a bug)
 * is an `error`.
 */
export function formOutcome(error: unknown): FormOutcome {
  return error instanceof ApiError ? formOutcomeFromStatus(error.status) : 'error'
}

/** How a form ended when the server answered 200 with `{ ok: false, code }`: a refusal, or a limit. */
export function codeOutcome(code: string): FormOutcome {
  return formOutcomeFromCode(code)
}

export function trackForm(form: AuthForm, outcome: FormOutcome): void {
  track(AnalyticsEvent.AuthFormSubmitted, { form, outcome })
}

/**
 * Why the microphone did not start: the refusal, the missing device, or a browser that cannot do what the
 * voice needs. `detail` is the exact way `getUserMedia` failed.
 */
export function micProblem(
  error: unknown,
  captureSupported: boolean,
): { reason: VoiceProblemReason; detail?: VoiceProblemDetail } {
  if (!captureSupported) return { reason: 'unsupported' }
  if (!(error instanceof MicrophoneError)) return { reason: 'unsupported' }
  if (error instanceof MicrophoneDeniedError) return { reason: 'permission_denied', detail: error.detail }
  return { reason: error.detail === 'not_found' ? 'no_microphone' : 'unsupported', detail: error.detail }
}

/** The reason alone, for callers that have no use for the detail. */
export function micProblemReason(error: unknown, captureSupported: boolean): VoiceProblemReason {
  return micProblem(error, captureSupported).reason
}

export function trackVoiceProblem(reason: VoiceProblemReason, detail?: VoiceProblemDetail): void {
  track(AnalyticsEvent.VoiceProblem, detail ? { reason, detail } : { reason })
}

/** Whether the page runs as an installed app (the display mode, or Safari's flag on the home screen). */
export function isStandalone(win: {
  matchMedia(query: string): { matches: boolean }
  navigator: object
}): boolean {
  try {
    return (
      win.matchMedia('(display-mode: standalone)').matches ||
      (win.navigator as { standalone?: boolean }).standalone === true
    )
  } catch {
    return false
  }
}

/**
 * Runs `action` once for each distinct `key` (null means "not yet"). An effect that only reports a
 * fact must not report it twice when React Strict Mode runs it twice in development.
 */
export function useOnceFor(key: string | null, action: () => void): void {
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (key === null || reported.current === key) return
    reported.current = key
    action()
    // `action` is a closure over the render that first saw the key; it is not a trigger.
  }, [key])
}
