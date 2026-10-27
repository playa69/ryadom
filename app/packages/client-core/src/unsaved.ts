/**
 * "Не сохранять этот разговор" (PROTEUS-246): a choice made before a conversation starts, apart from "Без памяти". A conversation held
 * unsaved lives in the agent's memory only; when the agent restarts it is gone, and what the person sees then is `UNSAVED_GONE`.
 */

export const UNSAVED_LABEL = 'Не сохранять этот разговор'
export const UNSAVED_HINT = 'Он не попадёт в журнал, итоги и память'
/** The note on the conversation screen, instead of "Без памяти". */
export const UNSAVED_NOTE = 'Не сохраняется'
export const UNSAVED_NOTE_TEXT = 'Этот разговор не попадёт в журнал, итоги и память'
/** The end sheet of an unsaved conversation: there is nothing to take away, so nothing is asked. */
export const UNSAVED_END_NOTE =
  'Разговор не сохранится: в журнале, итогах и памяти от него останется только пометка, что он был.'
/** What the closing alert says. */
export const UNSAVED_DONE_TEXT = 'Разговор завершён и не сохранён. Я рядом, когда понадоблюсь.'

export const UNSAVED_GONE = {
  title: 'Разговор не сохранён',
  text: 'Этот разговор шёл без сохранения, поэтому после перезапуска от него ничего не осталось. Можно начать новый.',
  home: 'На главную',
} as const

/** Whether a conversation is held unsaved. Only an answer that says `saved: false` counts: a gateway older than the client says nothing. */
export function isUnsaved(dialog: { saved?: boolean | null } | null | undefined): boolean {
  return dialog?.saved === false
}

const KEY = 'ryadom:unsaved-dialogs'

function readIds(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = storage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * Remembers, for the life of the tab, that a dialog was held unsaved, only its id: after a reload the screen can still say
 * "Разговор не сохранён" instead of "Разговор не найден". Storage that is not there changes nothing but that wording.
 */
export function rememberUnsaved(dialogId: string, storage?: Pick<Storage, 'getItem' | 'setItem'>): void {
  const target = storage ?? safeSessionStorage()
  if (!target) return
  try {
    const ids = readIds(target)
    if (!ids.includes(dialogId)) target.setItem(KEY, JSON.stringify([...ids, dialogId].slice(-20)))
  } catch {
    // Wording only: a full or blocked storage is not worth a failure.
  }
}

export function wasUnsaved(dialogId: string, storage?: Pick<Storage, 'getItem'>): boolean {
  const target = storage ?? safeSessionStorage()
  return target ? readIds(target).includes(dialogId) : false
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}
