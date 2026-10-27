import { allTests, wave1 } from '@ryadom/self-check/catalog'
import type { AnalyticsEventProperties, AnalyticsEvent } from '@ryadom/analytics/events'

/** The catalog «Тесты» (all waves) and the block «Самопроверка» of the diary (wave 1). */
export const shownTests = () => allTests
export const shownWave1 = () => wave1

export type SelfCheckFrom = AnalyticsEventProperties[AnalyticsEvent.SelfCheckOpened]['from']

export const TEST_EVENT = 'ryadom:self-check'

/** Open the sheet of one test from anywhere (the diary block, the catalog). */
export function openTest(testId: string, from: SelfCheckFrom): void {
  window.dispatchEvent(new CustomEvent(TEST_EVENT, { detail: { testId, from } }))
}
