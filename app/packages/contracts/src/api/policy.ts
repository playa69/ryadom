/**
 * What the app tells the person and what the server holds it to, in one place so that the screens
 * and the server job cannot drift apart.
 */

/**
 * The version of the terms of use and the privacy policy that the apps show on the first screen:
 * the date they came into force. The server records the version a person accepted; whether it is
 * still the current one is decided by the app, by comparing with this constant. Changing the
 * documents means changing this date, and everyone is asked again.
 */
export const POLICY_VERSION = '2026-10-04'

/**
 * How many days an anonymous account (no confirmed address) may go unopened before the server erases
 * it with everything the agent holds. Counted from the last sign-in, session refresh or conversation.
 */
export const ANONYMOUS_RETENTION_DAYS = 90
