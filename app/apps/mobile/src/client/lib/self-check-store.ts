import { useSyncExternalStore } from 'react'
import type { SavedResult } from '@ryadom/self-check/history'
import { f7 } from 'framework7-react'
import { latestSelfCheckResults } from './api'

/** The newest saved result of every test, shared by the block «Самопроверка» and the catalog (module state, like the diary). */
let latest: Record<string, SavedResult> = {}
const listeners = new Set<() => void>()

export function refreshLatestResults(): void {
  latestSelfCheckResults()
    .then((r) => {
      latest = Object.fromEntries(r.items.map((i) => [i.testId, i]))
      listeners.forEach((l) => l())
    })
    .catch(() => undefined)
}

export function useLatestResults(): Record<string, SavedResult> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => latest,
  )
}

/** The toast of a success (green) and of a failure (the same toast, red). */
export function notify(text: string, kind: 'success' | 'error'): void {
  f7.toast.create({ text, closeTimeout: 3000, cssClass: `rd-toast rd-toast--${kind}` }).open()
}

export const HISTORY_EVENT = 'ryadom:self-check-history'

/** Open the screen of one test (history and chart) from the block or the catalog. */
export function openHistory(testId: string): void {
  window.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: { testId } }))
}
