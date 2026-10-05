/**
 * Browser storage keys of the web client.
 *
 * localStorage and sessionStorage belong to the origin, and on the production host several clients
 * share one origin: this one under `/web`, the PWA under `/app` (apps/mobile). The PWA and the store
 * builds keep their original names (`ryadom_refreshToken`, `ryadom_device`, `ryadom.user`,
 * `ryadom.update.*`, `ryadom.install.*`) because renaming them would sign every installed app out
 * and lose the anonymous identity of the device. So the web client lives in its own namespace,
 * `ryadom.web.`, which no other client writes to and which does not start with the PWA's `ryadom_`.
 *
 * Every key this app stores must be built from `WEB_STORAGE_PREFIX`.
 */
export const WEB_STORAGE_PREFIX = 'ryadom.web.'

/** The cached user (localStorage). */
export const WEB_USER_KEY = `${WEB_STORAGE_PREFIX}user`

/** The sign-up in progress, kept per tab (sessionStorage). */
export const WEB_PENDING_AUTH_KEY = `${WEB_STORAGE_PREFIX}pending-auth`

/** Which view (text or voice) a dialog was left in, kept per tab (sessionStorage). */
export const webDialogViewKey = (dialogId: string): string => `${WEB_STORAGE_PREFIX}dialog-view.${dialogId}`
