import { GetUserByEmailQuery, GetUserByEmailQueryErrorCode, usersManager } from '@ryadom/core/managers/users-manager'
import assertNever from 'assert-never'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import type { DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import type { AccountKind, AnalyticsEventProperties, AnalyticsEvent } from '@ryadom/analytics/events'
import { createAnalyticsAdmin } from '@ryadom/analytics/admin'
import { createServerAnalytics, type ServerAnalytics } from '@ryadom/analytics/server'
import type { AppServerEnv } from './env'
import type { Logger } from './logger'

/**
 * Product analytics on the server (PostHog). The catalog of events is in `@ryadom/analytics`; this
 * file only wires it to the API: the client from env, the helpers the routes share.
 *
 * Analytics never takes part in the answer to a request. Every call is fire-and-forget, a failure is
 * logged at most once a minute, and nothing here is awaited on the way to a response except the one
 * lookup by email below, which runs only when analytics are on.
 */

/** How often a delivery failure reaches the log: a PostHog outage must not become a log flood. */
const ERROR_LOG_INTERVAL_MS = 60_000

/** A PostHog project token: `phc_` and the rest. Personal API keys start with `phx_` and are secrets. */
const PROJECT_TOKEN = /^phc_[A-Za-z0-9_-]{8,}$/

/**
 * The project token, or undefined when `POSTHOG_KEY` is empty OR is not a project token. The second
 * case is a guard, not a nicety: this value is handed to every visitor by `GET /api/analytics/config`,
 * so a personal API key (`phx_…`, write access to the organization) put in `POSTHOG_KEY` by mistake
 * must switch analytics off, never reach the clients.
 */
export function projectToken(env: Pick<AppServerEnv, 'POSTHOG_KEY'>): string | undefined {
  return env.POSTHOG_KEY !== undefined && PROJECT_TOKEN.test(env.POSTHOG_KEY) ? env.POSTHOG_KEY : undefined
}

/** True when `POSTHOG_KEY` is set to something that is not a project token (and so is ignored). */
export function hasInvalidProjectToken(env: Pick<AppServerEnv, 'POSTHOG_KEY'>): boolean {
  return env.POSTHOG_KEY !== undefined && projectToken(env) === undefined
}

export function createAnalytics(env: AppServerEnv, logger: Logger): ServerAnalytics {
  let lastLoggedAt = 0
  const admin =
    env.POSTHOG_PERSONAL_API_KEY && env.POSTHOG_PROJECT_ID
      ? createAnalyticsAdmin({
          apiHost: env.POSTHOG_UI_HOST,
          projectId: env.POSTHOG_PROJECT_ID,
          personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
          deleteEvents: env.POSTHOG_ERASE_EVENTS,
        })
      : undefined
  return createServerAnalytics({
    key: projectToken(env),
    host: env.POSTHOG_HOST,
    appEnv: env.APP_ENV,
    service: 'api',
    admin,
    onError: (error) => {
      const now = Date.now()
      if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) return
      lastLoggedAt = now
      logger.warn({ err: error }, 'Не удалось отправить событие аналитики')
    },
  })
}

/** What the clients are told at startup: whether to report, with which token, and which extras to load. */
export function toAnalyticsConfig(env: AppServerEnv): AnalyticsConfigApiResponse {
  const key = projectToken(env)
  const enabled = key !== undefined
  return {
    enabled,
    key: key ?? null,
    uiHost: env.POSTHOG_UI_HOST,
    environment: env.APP_ENV,
    features: {
      sessionReplay: enabled && env.POSTHOG_SESSION_REPLAY,
      surveys: enabled && env.POSTHOG_SURVEYS,
      autocapture: enabled && env.POSTHOG_AUTOCAPTURE,
      heatmaps: enabled && env.POSTHOG_HEATMAPS,
      errorTracking: enabled && env.POSTHOG_ERROR_TRACKING,
      webVitals: enabled && env.POSTHOG_WEB_VITALS,
      featureFlags: enabled && env.POSTHOG_FEATURE_FLAGS,
    },
  }
}

export function accountKind(user: { email: string | null }): AccountKind {
  return user.email === null ? 'anonymous' : 'email'
}

/** Tells PostHog what kind of account a person has. Called on every sign-in; it costs one queued message. */
export function identifyUser(analytics: ServerAnalytics, user: { id: string; email: string | null }): void {
  analytics.identify(user.id, { account_kind: accountKind(user) })
}

/**
 * The account id for an email, for the two operations that answer only "done" (confirming an email
 * and resetting a password). Null when analytics are off, so no query runs, and when there is no such
 * account. A failure is swallowed: the person's request has already succeeded.
 */
export async function userIdForEmail(analytics: ServerAnalytics, email: string): Promise<string | null> {
  if (!analytics.enabled) return null
  try {
    const found = await usersManager.execute(new GetUserByEmailQuery({ email }))
    if (found.success) return found.user.id
    switch (found.error) {
      case GetUserByEmailQueryErrorCode.USER_NOT_FOUND:
        return null
      default:
        return assertNever(found.error)
    }
  } catch {
    return null
  }
}

/** How a finished dialog went, from the summary the agent produced: the change in self-reported tension. */
export function tensionOutcome(
  summary: Pick<DialogSummaryApiResponse, 'tensionBefore' | 'tensionAfter'> | null,
): Pick<AnalyticsEventProperties[AnalyticsEvent.DialogEnded], 'tension_delta' | 'tension_improved'> {
  const before = summary?.tensionBefore
  const after = summary?.tensionAfter
  if (typeof before !== 'number' || typeof after !== 'number') return {}
  const delta = after - before
  return { tension_delta: delta, tension_improved: delta < 0 }
}
