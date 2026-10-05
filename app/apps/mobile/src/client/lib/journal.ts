import { useSyncExternalStore } from 'react'
import type { DialogListItemApiResponse } from '@ryadom/contracts/api/dialogs'
import { apiErrorText, listDialogs } from './api'

/**
 * The journal list and the entry open next to it. Module state rather than page state for two
 * reasons: the list has to refresh when a conversation ends on another tab, and the open entry
 * has to survive a window resize — on a wide screen it is a pane beside the list, on a narrow
 * one its own screen, and crossing the breakpoint must keep the same entry open.
 */

export interface JournalState {
  /** null — not loaded yet */
  items: DialogListItemApiResponse[] | null
  error: string
  /** The entry shown in the right pane on a wide screen. */
  openId: string | null
}

const INITIAL: JournalState = { items: null, error: '', openId: null }

let state: JournalState = INITIAL
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null
/** Bumped on reset, so a request started for the previous account cannot land after it. */
let generation = 0

function update(patch: Partial<JournalState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const journal = {
  /** Re-reads the list; parallel calls share one request. */
  refresh(): Promise<void> {
    if (inFlight) return inFlight
    const started = generation
    inFlight = listDialogs()
      .then((result) => {
        if (started === generation) update({ items: result.items, error: '' })
      })
      .catch((err: unknown) => {
        // Keep what is already on screen: a failed refresh should not blank a loaded list.
        if (started === generation) {
          update({ items: state.items ?? [], error: apiErrorText(err, {}, 'Не получилось загрузить журнал') })
        }
      })
      .finally(() => {
        if (started === generation) inFlight = null
      })
    return inFlight
  },

  open(dialogId: string | null): void {
    if (state.openId !== dialogId) update({ openId: dialogId })
  },

  /** The list item for an entry, if the list is loaded — its title, before the entry itself is. */
  peek(dialogId: string): DialogListItemApiResponse | undefined {
    return state.items?.find((item) => item.dialogId === dialogId)
  },

  /** On sign-in and sign-out: the next account must not see this one's list, not even for a frame. */
  reset(): void {
    generation += 1
    inFlight = null
    state = INITIAL
    for (const listener of listeners) listener()
  },
}

export function useJournal(): JournalState {
  return useSyncExternalStore(subscribe, () => state)
}
