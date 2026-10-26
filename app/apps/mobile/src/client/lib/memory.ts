import { useSyncExternalStore } from 'react'
import { createPendingForgets } from '@ryadom/client-core/memory'

/**
 * Memory state of this app that outlives a screen: the deleting of a note that can still be taken
 * back ("Вернуть" for five seconds). The rules live in @ryadom/client-core/memory. Nothing here is
 * written to storage: the texts of the notes stay in memory.
 */

export const pendingForgets = createPendingForgets()

/** On sign-in and sign-out: nothing of the previous account is shown or sent after it. */
export function resetMemoryState(): void {
  pendingForgets.cancelAll()
}

/** The ids of notes whose "×" can still be taken back. */
export function usePendingForgets(): ReadonlySet<string> {
  return useSyncExternalStore(pendingForgets.subscribe, pendingForgets.getSnapshot)
}
