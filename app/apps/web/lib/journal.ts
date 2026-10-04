import { useMemo, useSyncExternalStore } from 'react'
import type { DialogListItemApiResponse, ListDialogsApiResponse } from '@ryadom/contracts/api/dialogs'
import type { RyadomClient } from '@ryadom/client-core/client'
import { apiErrorText } from '@ryadom/client-core/errors'
import { useAuth, useClient } from './auth'

/**
 * The list of past conversations. Module state rather than screen state: the sidebar and the "all
 * conversations" page read the same list, and it is shown again instantly when the person comes back
 * to a screen.
 */

export interface JournalState {
  /** null: not loaded yet */
  items: DialogListItemApiResponse[] | null
  /** Cursor for the page after the last loaded one; null: nothing more to load. */
  next: string | null
  error: string
  /** The account this state belongs to; a different signed-in user never sees it. */
  owner: string | null
}

const INITIAL: JournalState = { items: null, next: null, error: '', owner: null }

let state: JournalState = INITIAL
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null
let moreInFlight: Promise<void> | null = null
/** Bumped whenever the state changes hands, so a request started for the previous account cannot land after it. */
let generation = 0

function emit(): void {
  for (const listener of listeners) listener()
}

function update(patch: Partial<JournalState>): void {
  state = { ...state, ...patch }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getState(): JournalState {
  return state
}

function adopt(owner: string | null): void {
  generation += 1
  inFlight = null
  moreInFlight = null
  state = { ...INITIAL, owner }
  emit()
}

/** The screens unmount on sign-out and cannot reset anything, so the next account's first call does. */
function claim(owner: string): void {
  if (state.owner !== owner) adopt(owner)
}

/**
 * A refresh brings the newest page only. Older pages the person has already opened ("show more") stay:
 * they continue after the last conversation of the new page, so the list does not shrink back to
 * twenty every time the screen gains focus.
 */
function mergeNewestPage(
  loaded: DialogListItemApiResponse[] | null,
  newest: ListDialogsApiResponse,
): Pick<JournalState, 'items' | 'next'> {
  const last = newest.items[newest.items.length - 1]
  const at = loaded && last && newest.next ? loaded.findIndex((item) => item.dialogId === last.dialogId) : -1
  if (!loaded || at === -1) return { items: newest.items, next: newest.next }

  const known = new Set(newest.items.map((item) => item.dialogId))
  const older = loaded.slice(at + 1).filter((item) => !known.has(item.dialogId))
  return older.length > 0
    ? { items: [...newest.items, ...older], next: state.next }
    : { items: newest.items, next: newest.next }
}

export const journal = {
  /** The raw state, owner included; screens read it through useJournal, which checks the owner. */
  snapshot: getState,

  /** Re-reads the list; parallel calls share one request. */
  refresh(client: RyadomClient, owner: string): Promise<void> {
    claim(owner)
    if (inFlight) return inFlight
    const started = generation
    const request = client
      .listDialogs()
      .then((result) => {
        if (started === generation) update({ ...mergeNewestPage(state.items, result), error: '' })
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
    inFlight = request
    return request
  },

  /** Appends the next page of older conversations, if there is one; parallel calls share one request. */
  loadMore(client: RyadomClient, owner: string): Promise<void> {
    claim(owner)
    const cursor = state.next
    if (!cursor || state.items === null) return Promise.resolve()
    if (moreInFlight) return moreInFlight
    const started = generation
    const request = client
      .listDialogs(cursor)
      .then((result) => {
        if (started !== generation) return
        const loaded = state.items ?? []
        const known = new Set(loaded.map((item) => item.dialogId))
        update({
          items: [...loaded, ...result.items.filter((item) => !known.has(item.dialogId))],
          next: result.next,
          error: '',
        })
      })
      .catch((err: unknown) => {
        if (started === generation) {
          update({ error: apiErrorText(err, {}, 'Не получилось загрузить журнал') })
        }
      })
      .finally(() => {
        if (started === generation) moreInFlight = null
      })
    moreInFlight = request
    return request
  },

  /** Forget everything: for code that ends the session and does not want to wait for the next account. */
  reset(): void {
    adopt(null)
  },
}

export interface JournalView extends JournalState {
  refresh(): Promise<void>
  loadMore(): Promise<void>
}

/** The state of the signed-in account plus `refresh` and `loadMore` bound to it; both are stable. */
export function useJournal(): JournalView {
  const client = useClient()
  const { user } = useAuth()
  const owner = user?.id ?? null
  const snapshot = useSyncExternalStore(subscribe, getState, getState)
  const current = snapshot.owner === owner ? snapshot : INITIAL

  const actions = useMemo(
    () => ({
      refresh: (): Promise<void> => (owner ? journal.refresh(client, owner) : Promise.resolve()),
      loadMore: (): Promise<void> => (owner ? journal.loadMore(client, owner) : Promise.resolve()),
    }),
    [client, owner],
  )
  return useMemo(() => ({ ...current, ...actions }), [current, actions])
}

const DAY_FORMAT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** "1 октября, 14:30". Composed from two parts: the joiner of a combined format differs between ICU versions. */
export function formatJournalDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${DAY_FORMAT.format(date)}, ${TIME_FORMAT.format(date)}`
}

export function tensionLabel(item: DialogListItemApiResponse): string | null {
  const { tensionBefore, tensionAfter } = item.summary ?? {}
  if (tensionBefore === null || tensionBefore === undefined) return null
  if (tensionAfter === null || tensionAfter === undefined) return `было ${tensionBefore}`
  return `${tensionBefore} → ${tensionAfter}`
}
