import { useSyncExternalStore } from 'react'
import { getFeatureFlag, isAnalyticsOptedOut, subscribeAnalyticsOptOut, subscribeFeatureFlags } from './browser'

/**
 * React bindings for `browser.ts`. A separate entry so that the landing, the API and anything else
 * that does not render with React never imports it.
 */

/**
 * A feature flag for the current person: `undefined` until the flags have loaded (or when analytics
 * are off), then `true`/`false` or the variant name. Render the default experience for `undefined`.
 */
export function useFeatureFlag(flag: string): string | boolean | undefined {
  return useSyncExternalStore(
    subscribeFeatureFlags,
    () => getFeatureFlag(flag),
    () => undefined,
  )
}

/** Whether this person has turned analytics off on this device; re-renders when they change it. */
export function useAnalyticsOptOut(): boolean {
  return useSyncExternalStore(subscribeAnalyticsOptOut, isAnalyticsOptedOut, () => false)
}
