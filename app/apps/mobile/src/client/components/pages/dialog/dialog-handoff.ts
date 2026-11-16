/**
 * The start of a conversation handed from home to the dialog screen through route props
 * (`initialMode`, `initialText`). Framework7 keeps route props in its history, so a later mount of
 * the same route — «назад» to an already opened conversation — delivers them again, while a text
 * must go out exactly once. What the props carried is absorbed here per dialog id and text:
 * a repeated mount with the same props gets the view it opened in back, but no text to send, while
 * a new text into the same resumed dialog (another start from home without a reload) still goes
 * out, because absorption compares the text, not only the dialog id.
 *
 * In memory only, like the greeting: after a reload the props are gone and the feed is restored
 * from the API.
 */

export type InitialMode = 'text' | 'voice'

export interface DialogHandoff {
  /** The view the conversation opens in. */
  mode: InitialMode
  /** The first message, trimmed; absent when this text was already absorbed for the dialog. */
  text?: string
}

interface AbsorbedStart {
  mode: InitialMode
  text: string
}

/** Dialogs whose start props were already consumed: the view they opened in and the sent text. */
const absorbed = new Map<string, AbsorbedStart>()

export function takeDialogHandoff(
  dialogId: string,
  initialMode?: InitialMode,
  initialText?: string,
): DialogHandoff | null {
  const text = initialText?.trim() ?? ''
  if (initialMode === undefined && !text) return null
  const known = absorbed.get(dialogId)
  if (known !== undefined) {
    // The dialog keeps the view it opened in; a repeated mount carries the same props, so only
    // a text not yet absorbed for this dialog is handed out again.
    if (!text || text === known.text) return { mode: known.mode }
    known.text = text
    return { mode: known.mode, text }
  }
  const mode: InitialMode = initialMode ?? 'voice'
  absorbed.set(dialogId, { mode, text })
  return text ? { mode, text } : { mode }
}
