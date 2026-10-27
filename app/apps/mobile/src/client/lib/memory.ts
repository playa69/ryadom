import { useSyncExternalStore } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { MEMORY_SETTINGS_ERRORS, createPendingForgets } from '@ryadom/client-core/memory'
import type { UpdateMemorySettingsApiResponse } from '@ryadom/contracts/api/memory'
import { apiErrorText, codeText, setMemoryEnabled } from './api'

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

/**
 * Turns memory on after the consent sheet's "Включить память": the one place both the profile and the
 * invitation on home go through. Returns the settings the server answered with, or the text to show.
 */
export async function enableMemory(): Promise<
  { ok: true; data: UpdateMemorySettingsApiResponse } | { ok: false; text: string }
> {
  const fallback = 'Не получилось включить память'
  try {
    const result = await setMemoryEnabled(true)
    if (!result.ok) return { ok: false, text: codeText(MEMORY_SETTINGS_ERRORS, result.code, fallback) }
    track(AnalyticsEvent.MemoryEnabled, { enabled: true })
    return { ok: true, data: result.data }
  } catch (error) {
    return { ok: false, text: apiErrorText(error, {}, fallback) }
  }
}

/** The invitation is answered once on this device; storage that fails reads as "not dismissed". */
export const MEMORY_INVITE_STORAGE_KEY = 'ryadom.memory-invite-dismissed'

export function memoryInviteDismissed(): boolean {
  try {
    return localStorage.getItem(MEMORY_INVITE_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export function dismissMemoryInvite(): void {
  try {
    localStorage.setItem(MEMORY_INVITE_STORAGE_KEY, String(Date.now()))
  } catch {
    // The sheet may come back next time: nothing worse.
  }
}
