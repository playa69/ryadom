import type { StartDialogApiResponse } from '@ryadom/contracts/api/dialogs'

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
