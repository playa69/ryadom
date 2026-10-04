import { peekDialogHandoff } from './dialog-start'

/**
 * The two faces of the conversation screen: the voice (the sphere) and the typed text (the feed and
 * the input box). Voice is the main one; text is one tap away.
 */
export type DialogView = 'voice' | 'text'

const key = (dialogId: string) => `ryadom.dialog-view.${dialogId}`

/**
 * Per tab, not forever: a reload or a way back into a conversation that was being typed stays on the
 * text instead of dropping the person on the sphere. Only the word "voice" or "text" is kept, none of
 * the conversation. Storage can be missing or refuse (a private window, blocked site data).
 */
export function rememberDialogView(dialogId: string, view: DialogView): void {
  try {
    sessionStorage.setItem(key(dialogId), view)
  } catch {
    // Not remembering the view is harmless: the next visit opens on the voice.
  }
}

function recalledDialogView(dialogId: string): DialogView | null {
  try {
    const value = sessionStorage.getItem(key(dialogId))
    return value === 'voice' || value === 'text' ? value : null
  } catch {
    return null
  }
}

/**
 * What the screen opens on. What the person did on home decides first: the microphone or "Поговорить"
 * without words mean the voice, words typed alone mean the text (they are the first message). Otherwise
 * the view this tab had last, and for a conversation never opened here, the voice.
 */
export function initialDialogView(dialogId: string): DialogView {
  const handoff = peekDialogHandoff(dialogId)
  // Words typed and then the microphone pressed: the press is the later wish, and the words still go out
  // as the first message.
  if (handoff?.listen) return 'voice'
  if (handoff?.draft) return 'text'
  return recalledDialogView(dialogId) ?? 'voice'
}
