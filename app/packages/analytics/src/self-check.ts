import { track } from './browser'
import { AnalyticsEvent, type SelfCheckFrom } from './events'

/**
 * The two reports of the tests that both clients make the same way (the rest are made where the action
 * is, next to the button). Neither takes a score, a level, an answer or a word typed by the person:
 * the event says where a list was opened and whether a search found anything, nothing more.
 */

/** A list of tests or the screen of one test was opened. `from` names the screen, not what is on it. */
export function reportSelfCheckOpened(from: SelfCheckFrom): void {
  track(AnalyticsEvent.SelfCheckOpened, { from })
}

/** How long the search field has to stay still before the search counts as made, not as typing. */
export const SEARCH_SETTLE_MS = 1_500

/**
 * Reports a search in the catalog once the typing has stopped: one event per query the person left on
 * the screen, not one per key. An empty query is not a search. Returns the way to cancel the report
 * (the query changed again, or the screen went away). Only `found` goes out; the words never reach here.
 */
export function scheduleSelfCheckSearchReport(
  typed: boolean,
  found: boolean,
  settleMs = SEARCH_SETTLE_MS,
): () => void {
  if (!typed) return () => undefined
  const timer = setTimeout(() => track(AnalyticsEvent.SelfCheckSearched, { found }), settleMs)
  return () => clearTimeout(timer)
}
