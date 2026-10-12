import { useSyncExternalStore } from 'react'
import type { RyadomClient } from '@ryadom/client-core/client'
import { createMemoryCard, createPendingForgets, type MemoryCardState } from '@ryadom/client-core/memory'

/**
 * Memory state of the web app that outlives a screen: the card "Я запомнил" (the conversation ends on
 * its own screen, the card appears on home a few seconds later) and the forgetting that can still be
 * taken back. The rules live in @ryadom/client-core/memory. Nothing here is written to storage: the
 * texts of the facts stay in memory.
 */

export const memoryCard = createMemoryCard()

/** Starts looking for the card "Я запомнил" of a conversation that has just ended. */
export function watchMemoryCard(client: RyadomClient, dialogId: string, owner: string): Promise<void> {
  return memoryCard.watch(dialogId, owner, client.getMemoryChanges)
}

export const pendingForgets = createPendingForgets()

/** On sign-in and sign-out: nothing of the previous account is shown or sent after it. */
export function resetMemoryState(): void {
  memoryCard.reset()
  pendingForgets.cancelAll()
}

/**
 * A browser is the place a computer is most often shared from: the screen "Память" opens with the
 * texts hidden behind "Показать" until the person says this one is theirs alone.
 */
export const HIDE_MEMORY_TEXTS_DEFAULT = true

/** The card of the signed-in account, or null. */
export function useMemoryCard(owner: string | null): MemoryCardState | null {
  const card = useSyncExternalStore(memoryCard.subscribe, memoryCard.getSnapshot, () => null)
  return card && card.owner === owner ? card : null
}

const NONE: ReadonlySet<string> = new Set()

/** The ids of facts whose "Забыть" can still be taken back. */
export function usePendingForgets(): ReadonlySet<string> {
  return useSyncExternalStore(pendingForgets.subscribe, pendingForgets.getSnapshot, () => NONE)
}
