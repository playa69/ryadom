import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '@ryadom/core/managers/users-manager'
import assertNever from 'assert-never'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import type { DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import { accountKindOf, type AnalyticsEventProperties, type AnalyticsEvent } from '@ryadom/analytics/events'
import { createAnalyticsAdmin } from '@ryadom/analytics/admin'
import {
  createServerAnalytics,
  type AccountAnalyticsState,
  type ServerAnalytics,
  type ServerAnalyticsClient,
} from '@ryadom/analytics/server'
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
        })
      : undefined
  return createServerAnalytics({
    key: projectToken(env),
    host: env.POSTHOG_HOST,
    appEnv: env.APP_ENV,
    service: 'api',
    admin,
    // Asked before anything is reported about a person, so "I turned it off" holds on the server too, and the
    // account says whose traffic it is (people, a load test, the team).
    accountState,
    release: env.RELEASE,
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

/** Kept for older clients, which take from here what to collect (see `AnalyticsFeatures`). */
const LEGACY_CLIENT_FEATURES: AnalyticsConfigApiResponse['features'] = {
  sessionReplay: false,
  clickCapture: true,
  heatmapCapture: false,
  errorTracking: true,
  webVitals: true,
  featureFlags: false,
  autocapture: false,
  heatmaps: false,
}

/** What the clients are told at startup: whether to report, and with which token. */
export function toAnalyticsConfig(env: AppServerEnv): AnalyticsConfigApiResponse {
  const key = projectToken(env)
  return {
    enabled: key !== undefined,
    key: key ?? null,
    uiHost: env.POSTHOG_UI_HOST,
    environment: env.APP_ENV,
    features: LEGACY_CLIENT_FEATURES,
  }
}

/** Tells PostHog what kind of account a person has. Called on every sign-in; it costs one queued message. */
export function identifyUser(
  analytics: ServerAnalytics,
  user: { id: string; email: string | null; telegramId: number | null },
): void {
  analytics.identify(user.id, { account_kind: accountKindOf({ email: user.email, telegramLinked: user.telegramId !== null }) })
}

/**
 * What the account says about being reported on: whether it asked for analytics to be off, and whose traffic it
 * is. An account that is gone counts as opted out: nothing is reported about a person who has just been erased.
 */
async function accountState(userId: string): Promise<AccountAnalyticsState> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return { optOut: true, trafficType: 'real' }
      default:
        return assertNever(found.error)
    }
  }
  return {
    optOut: found.user.analyticsOptOut || found.user.isDeleted,
    trafficType: found.user.trafficType,
  }
}

const DIALOG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The `dialog_id` property of an event: the dialog's own random id. Whatever is not an id (the socket takes the
 * value from the client's first frame) is left out, not reported.
 */
export function dialogIdProperty(dialogId: string | null | undefined): { dialog_id?: string } {
  return typeof dialogId === 'string' && DIALOG_ID.test(dialogId) ? { dialog_id: dialogId } : {}
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * How much was said, for `dialog_ended`: the whole dialog when the agent counted it (it sees every connection and
 * every rollout), otherwise what this connection saw, marked as such. Over REST there is no connection to fall
 * back on, so the counts are left out.
 */
export function messageCounts(
  summary: { userMessages?: unknown; assistantMessages?: unknown } | null | undefined,
  connection?: { user: number; assistant: number },
): Pick<AnalyticsEventProperties[AnalyticsEvent.DialogEnded], 'counts' | 'user_messages' | 'assistant_messages'> {
  const user = count(summary?.userMessages)
  const assistant = count(summary?.assistantMessages)
  if (user !== undefined && assistant !== undefined) {
    return { counts: 'dialog', user_messages: user, assistant_messages: assistant }
  }
  if (!connection) return {}
  return { counts: 'connection', user_messages: connection.user, assistant_messages: connection.assistant }
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
