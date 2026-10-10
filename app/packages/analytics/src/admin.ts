/**
 * The little of PostHog's management API that the server needs: erasing a person.
 *
 * The product promises to erase everything when an account is deleted, and a pseudonymous profile with
 * its history in PostHog is still something about that person. Deleting it takes a personal API key
 * (a secret, unlike the project token) and a call to the app host, not the ingestion host.
 *
 * Everything here is best effort and never throws: the account is already gone when this runs, and a
 * failed erasure is reported to the caller as `false` so it can be logged and cleaned up by hand.
 */

export interface AnalyticsAdminOptions {
  /** The PostHog web/API host, e.g. `https://eu.posthog.com` (not the `i.` ingestion host). */
  apiHost: string
  projectId: string
  /** A personal API key with the `person:write` scope. */
  personalApiKey: string
  /**
   * Also erase the person's events. Off keeps them: the profile and recordings go, the history stays
   * under the account's id, which is what lets past activity (daily users, retention) still be counted.
   * Those events are pseudonymous, not anonymous, for as long as something else maps the id to a person.
   */
  deleteEvents: boolean
  timeoutMs?: number
  /** For tests. */
  fetch?: typeof fetch
}

export interface AnalyticsAdmin {
  /** Queues the person and their recordings (and, if configured, their events) for deletion. True when PostHog accepted it without errors. */
  deletePerson(distinctId: string): Promise<boolean>
}

const DEFAULT_TIMEOUT_MS = 10_000

export function createAnalyticsAdmin(options: AnalyticsAdminOptions): AnalyticsAdmin {
  const host = options.apiHost.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init))

  return {
    async deletePerson(distinctId) {
      try {
        const response = await doFetch(`${host}/api/projects/${encodeURIComponent(options.projectId)}/persons/bulk_delete/`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.personalApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            distinct_ids: [distinctId],
            delete_events: options.deleteEvents,
            delete_recordings: true,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return false
        const result = (await response.json()) as { deletion_errors?: unknown[] }
        return !result.deletion_errors || result.deletion_errors.length === 0
      } catch {
        return false
      }
    },
  }
}
