import { POLICY_VERSION } from '@ryadom/contracts/api/policy'

/**
 * Whether a start on home must first pass the consent sheet
 * (`openspec/changes/add-fast-dialog-start`, «Согласие при первом действии»). On the PWA and in
 * Telegram there is no consent gate before home anymore: the first text or voice start with no
 * current consent on record opens the sheet over home instead of sending anything. An account with
 * the current version recorded never sees it, and a confirmation given this session is not asked
 * for again, so a failed start can be retried without the sheet. The native shell keeps its gate
 * on the first screen and never needs the sheet.
 */
export function needsFirstActionConsent(state: {
  native: boolean
  authenticated: boolean
  /** What the app knows about the accepted terms version: undefined until asked, null when none. */
  consentVersion: string | null | undefined
  /** The person already pressed «Продолжить» with the tick in this session. */
  confirmedInSession: boolean
}): boolean {
  if (state.native || state.confirmedInSession) return false
  return !(state.authenticated && state.consentVersion === POLICY_VERSION)
}
