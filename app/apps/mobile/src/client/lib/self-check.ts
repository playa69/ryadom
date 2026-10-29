import { visible, wave1 } from '@ryadom/self-check/catalog'
import type { AnalyticsEventProperties, AnalyticsEvent } from '@ryadom/analytics/events'

/**
 * Tests inside the app are switched as a whole (add-self-check-tests, D9): off, the diary has neither the block
 * «Самопроверка» nor the segment «Тесты». Build-time variable, like the web app's.
 */
export const SELF_CHECK_ENABLED = import.meta.env.VITE_SELF_CHECK_ENABLED === '1'

/** Builds for dev and staging also show the tests that wait for the owner's sign-off (status `review`). */
const SELF_CHECK_PREVIEW = import.meta.env.VITE_SELF_CHECK_PREVIEW === '1'

export const shownTests = () => (SELF_CHECK_ENABLED ? visible(SELF_CHECK_PREVIEW) : [])
export const shownWave1 = () => (SELF_CHECK_ENABLED ? visible(SELF_CHECK_PREVIEW, wave1) : [])

export type SelfCheckFrom = AnalyticsEventProperties[AnalyticsEvent.SelfCheckOpened]['from']

export const TEST_EVENT = 'ryadom:self-check'

/** Open the sheet of one test from anywhere (the diary block, the catalog). */
export function openTest(testId: string, from: SelfCheckFrom): void {
  window.dispatchEvent(new CustomEvent(TEST_EVENT, { detail: { testId, from } }))
}
