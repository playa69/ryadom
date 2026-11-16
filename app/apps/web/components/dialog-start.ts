import type { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { webDialogGreetingKey } from '../lib/storage-keys'

/**
 * What `POST /api/dialogs` returned, handed from the home screen to the dialog screen. The dialog
 * id is the only thing in the URL: the greeting and the "we were apart" hint stay out of it, where
 * they would end up in history, logs and referrers.
 *
 * In memory, plus the greeting of a fresh start per tab (sessionStorage): the history from the API
 * does not hold it (the agent keeps it apart from the messages), so without that a screen mounted
 * again after a reload would lose it from the feed. Nothing else of the conversation is stored.
 */
export interface DialogStart {
  greeting: string | null
  resumed: boolean
  sinceLastDialogHours: number | null
  /** `off`: held "without memory" (the screen says so). Absent from a gateway that predates memory. */
  memoryMode?: DialogMemoryMode
  /** `false`: held unsaved ("Не сохранять этот разговор"); the screen says so. Absent from a gateway that predates it. */
  saved?: boolean
  /** Whether the person's memory was on when it started: the card "Я запомнил" is awaited only then. */
  memoryEnabled?: boolean
}

/**
 * What the person did on home before the conversation opened: the text they had typed (it becomes
 * the first message) and whether they pressed the microphone (the screen starts listening). Kept
 * apart from `DialogStart` because it is used up exactly once, however often the screen mounts.
 */
export interface DialogHandoff {
  draft?: string
  listen?: boolean
}

const starts = new Map<string, DialogStart>()
const handoffs = new Map<string, DialogHandoff>()
/** Dialogs whose fresh start was already consumed by a screen. */
const claimed = new Set<string>()

/**
 * Arms the start of `dialogId` for the screen that opens next. Call it once per press: the server
 * hands the same id back when a conversation is already open, so a second call for a press that
 * was already consumed would arm a draft nobody is going to claim until the dialog is next opened.
 * Keeping that from happening is the caller's job (home refuses a second start while one is under way).
 */
export function rememberDialogStart(dialogId: string, start: DialogStart, handoff?: DialogHandoff): void {
  starts.set(dialogId, start)
  claimed.delete(dialogId)
  persistGreeting(dialogId, start)
  if (handoff?.draft || handoff?.listen) handoffs.set(dialogId, handoff)
  else handoffs.delete(dialogId)
}

export function readDialogStart(dialogId: string): DialogStart | null {
  return starts.get(dialogId) ?? null
}

/**
 * The home screen's draft and microphone request, returned once and then forgotten. Browser "back"
 * to a dialog must not send the same text again or switch the microphone on by itself.
 */
export function takeDialogHandoff(dialogId: string): DialogHandoff | null {
  const handoff = handoffs.get(dialogId) ?? null
  handoffs.delete(dialogId)
  return handoff
}

/**
 * The handoff without using it up: the screen needs to know before its first render whether it opens
 * on the voice or on the typed text, and `takeDialogHandoff` runs later, once, in an effect.
 */
export function peekDialogHandoff(dialogId: string): DialogHandoff | null {
  return handoffs.get(dialogId) ?? null
}

/**
 * Returns the start exactly once per newly created dialog: only then the feed is known to hold
 * nothing but the greeting, so the screen may connect at once. Any other entry (browser "back",
 * a resumed dialog, a reload that emptied this map) must read the history first.
 */
export function claimFreshStart(dialogId: string): DialogStart | null {
  const start = starts.get(dialogId)
  if (!start || start.resumed || claimed.has(dialogId)) return null
  claimed.add(dialogId)
  return start
}

/**
 * The greeting of a fresh start, per tab like the view (`dialog-view.ts`). Only the agent's own
 * words, and only of a conversation that is kept: a resumed start's greeting is said aloud but never
 * joins the feed, and an unsaved conversation leaves no trace. Storage can be missing or refuse.
 */
function persistGreeting(dialogId: string, start: DialogStart): void {
  if (start.resumed || start.saved === false || !start.greeting) return
  try {
    sessionStorage.setItem(webDialogGreetingKey(dialogId), start.greeting)
  } catch {
    // Not remembering the greeting only means a reload restores the feed without it.
  }
}

function recalledGreeting(dialogId: string): string | null {
  try {
    return sessionStorage.getItem(webDialogGreetingKey(dialogId))
  } catch {
    return null
  }
}

/**
 * The greeting this dialog's feed began with, however the screen was reached: the start of this
 * page load first, then what this tab remembered of one. A resumed start's own greeting is not it,
 * so for one the remembered greeting of the dialog's fresh start answers.
 */
export function feedDialogGreeting(dialogId: string): string | null {
  const start = starts.get(dialogId)
  if (start && !start.resumed) return start.greeting
  return recalledGreeting(dialogId)
}
