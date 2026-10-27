import { useSyncExternalStore } from 'react'
import { createPendingForgets } from '@ryadom/client-core/memory'

/**
 * Memory state of the web app that outlives a screen: the deletion of a note that can still be taken
 * back ("Вернуть", five seconds). The rules live in @ryadom/client-core/memory. Nothing here is written
 * to storage: the texts of the notes stay in memory.
 */

export const pendingForgets = createPendingForgets()

/** On sign-in and sign-out: nothing of the previous account is sent after it. */
export function resetMemoryState(): void {
  pendingForgets.cancelAll()
}

/**
 * A browser is the place a computer is most often shared from: the sheet "Что помнит Рядом" opens with
 * the texts hidden behind "Показать" until the person says this one is theirs alone.
 */
export const HIDE_MEMORY_TEXTS_DEFAULT = true

const NONE: ReadonlySet<string> = new Set()

/** The ids of notes whose deletion can still be taken back. */
export function usePendingForgets(): ReadonlySet<string> {
  return useSyncExternalStore(pendingForgets.subscribe, pendingForgets.getSnapshot, () => NONE)
}
