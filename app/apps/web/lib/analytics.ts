import { useEffect, useRef } from 'react'
import { track } from '@ryadom/analytics/browser'
import {
  AnalyticsEvent,
  type AuthForm,
  type FormOutcome,
  type VoiceProblemReason,
} from '@ryadom/analytics/events'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { ResetPasswordApiErrorCode } from '@ryadom/contracts/api/auth/reset-password'
import { ApiError } from '@ryadom/client-core/errors'
import { MicrophoneDeniedError } from '@ryadom/client-core/voice/capture'

/**
 * The small pieces the screens share to report what only the screen knows. The events themselves are
 * the catalog's (`@ryadom/analytics/events`); nothing here ever takes a piece of text: a form reports
 * which form and how it ended, never what was typed.
 */

/** The server named a rule that was broken, and the rule is "too many tries": a limit, not a refusal. */
const RATE_LIMITED_CODES: ReadonlySet<string> = new Set([
  ConfirmEmailApiErrorCode.TOO_MANY_ATTEMPTS,
  ResetPasswordApiErrorCode.TOO_MANY_ATTEMPTS,
])

/**
 * How a form ended, from the error its request threw. `invalid` is a validation message (400/422),
 * `rejected` is the server saying no (the other 4xx, a wrong password included), `error` is the
 * request not getting a proper answer (no connection, a 5xx, anything unexpected).
 */
export function formOutcome(error: unknown): FormOutcome {
  if (!(error instanceof ApiError)) return 'error'
  if (error.status === 429) return 'rate_limited'
  if (error.status === 400 || error.status === 422) return 'invalid'
  if (error.status >= 400 && error.status < 500) return 'rejected'
  return 'error'
}

/** How a form ended when the server answered 200 with `{ ok: false, code }`: a refusal, or a limit. */
export function codeOutcome(code: string): FormOutcome {
  return RATE_LIMITED_CODES.has(code) ? 'rate_limited' : 'rejected'
}

export function trackForm(form: AuthForm, outcome: FormOutcome): void {
  track(AnalyticsEvent.AuthFormSubmitted, { form, outcome })
}

/**
 * Why the microphone did not start. The capture module folds every `getUserMedia` failure into
 * `MicrophoneDeniedError`, so a missing microphone cannot be told from a refused permission here.
 * Anything else failed after the microphone opened (the audio context, the worklet): the browser
 * cannot do what the voice needs.
 */
export function micProblemReason(error: unknown, captureSupported: boolean): VoiceProblemReason {
  if (!captureSupported) return 'unsupported'
  return error instanceof MicrophoneDeniedError ? 'permission_denied' : 'unsupported'
}

export function trackVoiceProblem(reason: VoiceProblemReason): void {
  track(AnalyticsEvent.VoiceProblem, { reason })
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
