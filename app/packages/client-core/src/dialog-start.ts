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
 * What a press of "start" does with the answer of `POST /api/dialogs`:
 *
 * - `ask`: an open dialog with messages came back; the person decides (see `shouldAskToResume`). A
 *   "new one" then goes out with the chosen memory mode.
 * - `restart`: an open but empty dialog came back in the other memory mode. A returned dialog keeps
 *   the mode it was started with, and there is nothing in it to lose, so it is ended and a new one is
 *   started in the mode the person chose, without asking them.
 * - `open`: go to the dialog.
 *
 * `memoryMode` is read defensively, like `messageCount`: a gateway older than the client does not send it.
 */
export type StartStep = 'open' | 'ask' | 'restart'

export function nextStartStep(
  start: Pick<StartDialogApiResponse, 'resumed' | 'messageCount' | 'memoryMode'>,
  wanted: DialogMemoryMode | undefined,
): StartStep {
  if (shouldAskToResume(start)) return 'ask'
  const mode = start.memoryMode as DialogMemoryMode | undefined
  if (start.resumed && wanted !== undefined && mode !== undefined && mode !== wanted) return 'restart'
  return 'open'
}
