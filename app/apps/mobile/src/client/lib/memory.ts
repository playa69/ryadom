import { useSyncExternalStore } from 'react'
import { createMemoryCard, createPendingForgets, type MemoryCardState } from '@ryadom/client-core/memory'
import { getMemoryChanges } from './api'

/**
 * Memory state of this app that outlives a screen: the card "Я запомнил" (the conversation ends on
 * its own screen, the card appears on home a few seconds later) and the forgetting that can still be
 * taken back. The rules live in @ryadom/client-core/memory; here they are bound to this app's client.
 * Nothing here is written to storage: the texts of the facts stay in memory.
 */

export const memoryCard = createMemoryCard()

/** Starts looking for the card "Я запомнил" of a conversation that has just ended. */
export function watchMemoryCard(dialogId: string, owner: string): Promise<void> {
  return memoryCard.watch(dialogId, owner, getMemoryChanges)
}

export const pendingForgets = createPendingForgets()

/**
 * Where this device keeps "Скрывать тексты" of the screen "Память". The PWA shares its origin with the
 * web client, whose keys all start with `ryadom.web.`, so this one cannot collide with them.
 */
export const HIDE_MEMORY_TEXTS_KEY = 'ryadom.memoryHidden'

/** A phone is usually the person's own: texts are shown unless they choose otherwise. */
export const HIDE_MEMORY_TEXTS_DEFAULT = false

/** On sign-in and sign-out: nothing of the previous account is shown or sent after it. */
export function resetMemoryState(): void {
  memoryCard.reset()
  pendingForgets.cancelAll()
}

/** The card of the signed-in account, or null. */
export function useMemoryCard(owner: string | null): MemoryCardState | null {
  const card = useSyncExternalStore(memoryCard.subscribe, memoryCard.getSnapshot)
  return card && card.owner === owner ? card : null
}

/** The ids of facts whose "Забыть" can still be taken back. */
export function usePendingForgets(): ReadonlySet<string> {
  return useSyncExternalStore(pendingForgets.subscribe, pendingForgets.getSnapshot)
}
