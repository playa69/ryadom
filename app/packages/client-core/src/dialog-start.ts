import type { StartDialogApiResponse } from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'

/**
 * Whether the person is asked something after pressing "start". A plain start returns the dialog they
 * left open (`resumed`); if something was said in it, they decide whether to continue it or to end it
 * and begin a new one. An open dialog with no messages holds nothing to lose, so it is simply continued.
 *
 * `messageCount` is read defensively: a gateway older than the client does not send it, and then there
 * is nothing to ask about, which is how a start behaved before the question existed.
 */
export function shouldAskToResume(start: Pick<StartDialogApiResponse, 'resumed' | 'messageCount'>): boolean {
  return start.resumed && typeof start.messageCount === 'number' && start.messageCount > 0
}

/**
 * The memory mode the person chose on home for the next conversation: `off` is "without memory". The
 * switch is shown only while their memory is on, so without it there is nothing to choose and nothing
 * is asked of the server (`undefined`).
 */
export function chosenMemoryMode(
  memoryEnabled: boolean | undefined,
  withoutMemory: boolean,
): DialogMemoryMode | undefined {
  if (memoryEnabled !== true) return undefined
  return withoutMemory ? DialogMemoryMode.Off : DialogMemoryMode.On
}

/**
 * What the person chose on home for the next conversation: "Без памяти" and "Не сохранять этот разговор" are two choices apart.
 * An unsaved conversation has no memory whatever the switch says, so it asks for none.
 */
export function chosenStart(
  memoryEnabled: boolean | undefined,
  withoutMemory: boolean,
  unsaved: boolean,
): { memory: DialogMemoryMode | undefined; saved: boolean } {
  return { memory: unsaved ? undefined : chosenMemoryMode(memoryEnabled, withoutMemory), saved: !unsaved }
}

/**
 * What a press of "start" does with the answer of `POST /api/dialogs`:
 *
 * - `ask`: an open dialog with messages came back; the person decides (see `shouldAskToResume`). A
 *   "new one" then goes out with the chosen memory mode and the chosen "save or not".
 * - `restart`: an open but empty dialog came back in the other memory mode or saved the other way. A
 *   returned dialog keeps the choices it was started with, and there is nothing in it to lose, so it is
 *   ended and a new one is started with what the person chose, without asking them.
 * - `open`: go to the dialog.
 *
 * `memoryMode` and `saved` are read defensively, like `messageCount`: a gateway older than the client does not send them.
 */
export type StartStep = 'open' | 'ask' | 'restart'

export function nextStartStep(
  start: Pick<StartDialogApiResponse, 'resumed' | 'messageCount' | 'memoryMode' | 'saved'>,
  wanted: DialogMemoryMode | undefined,
  wantedSaved = true,
): StartStep {
  if (shouldAskToResume(start)) return 'ask'
  if (!start.resumed) return 'open'
  // An unsaved dialog has memory off too, so the memory mode cannot tell the two choices apart: its own `saved` does.
  if ((start.saved !== false) !== wantedSaved) return 'restart'
  const mode = start.memoryMode as DialogMemoryMode | undefined
  if (wanted !== undefined && mode !== undefined && mode !== wanted) return 'restart'
  return 'open'
}
