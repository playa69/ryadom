import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '@ryadom/core/managers/users-manager'
import assertNever from 'assert-never'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import type { DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import { accountKindOf, type AnalyticsEventProperties, type AnalyticsEvent } from '@ryadom/analytics/events'
import { createAnalyticsAdmin } from '@ryadom/analytics/admin'
import { createServerAnalytics, type ServerAnalytics, type ServerAnalyticsClient } from '@ryadom/analytics/server'
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

export function createAnalytics(
  env: AppServerEnv,
  logger: Logger,
  /** For tests: the PostHog client and the delay before erasing are replaced. */
  overrides: { client?: ServerAnalyticsClient; erasureDelayMs?: number } = {},
): ServerAnalytics {
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
    // Asked before anything is reported about a person, so "I turned it off" holds on the server too.
    isOptedOut: accountOptedOut,
    ...(overrides.client ? { client: overrides.client } : {}),
    ...(overrides.erasureDelayMs !== undefined ? { erasureDelayMs: overrides.erasureDelayMs } : {}),
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
      clickCapture: enabled && env.POSTHOG_CLICK_CAPTURE,
      heatmapCapture: enabled && env.POSTHOG_HEATMAP_CAPTURE,
      errorTracking: enabled && env.POSTHOG_ERROR_TRACKING,
      webVitals: enabled && env.POSTHOG_WEB_VITALS,
      featureFlags: enabled && env.POSTHOG_FEATURE_FLAGS,
      // Clients shipped before the new names read these two; they cannot strip what the new ones can.
      autocapture: false,
      heatmaps: false,
    },
  }
}

/** Tells PostHog what kind of account a person has. Called on every sign-in; it costs one queued message. */
export function identifyUser(analytics: ServerAnalytics, user: { id: string; email: string | null }): void {
  analytics.identify(user.id, { account_kind: accountKindOf(user) })
}

/**
 * Whether the account asked for analytics to be off. An account that is gone counts as opted out:
 * nothing is reported about a person who has just been erased.
 */
async function accountOptedOut(userId: string): Promise<boolean> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return true
      default:
        return assertNever(found.error)
    }
  }
  return found.user.analyticsOptOut || found.user.isDeleted
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
