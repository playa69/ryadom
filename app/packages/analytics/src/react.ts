import { useSyncExternalStore } from 'react'
import { isAnalyticsOptedOut, subscribeAnalyticsOptOut } from './browser'

/**
 * React bindings for `browser.ts`. A separate entry so that the landing, the API and anything else
 * that does not render with React never imports it.
 */

/** Whether this person has turned analytics off on this device; re-renders when they change it. */
export function useAnalyticsOptOut(): boolean {
  return useSyncExternalStore(subscribeAnalyticsOptOut, isAnalyticsOptedOut, () => false)
}
