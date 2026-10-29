import { useEffect, useSyncExternalStore } from 'react'
import { isAnalyticsOptedOut, subscribeAnalyticsOptOut } from './browser'
import type { SelfCheckFrom } from './events'
import { reportSelfCheckOpened, scheduleSelfCheckSearchReport } from './self-check'

/**
 * React bindings for `browser.ts`. A separate entry so that the landing, the API and anything else
 * that does not render with React never imports it.
 */

/** Whether this person has turned analytics off on this device; re-renders when they change it. */
export function useAnalyticsOptOut(): boolean {
  return useSyncExternalStore(subscribeAnalyticsOptOut, isAnalyticsOptedOut, () => false)
}

/** Reports once, when the screen is shown, that a list of tests was opened from `from`. */
export function useSelfCheckOpened(from: SelfCheckFrom): void {
  useEffect(() => reportSelfCheckOpened(from), [from])
}

/**
 * Reports a search in the catalog of tests once the person stops typing. The query is here only to tell
 * "typing goes on" from "settled" and to see that it is not empty: the words are never passed on, only `found`.
 */
export function useSelfCheckSearchReport(query: string, found: boolean): void {
  const typed = query.trim() !== ''
  useEffect(() => scheduleSelfCheckSearchReport(typed, found), [query, typed, found])
}
