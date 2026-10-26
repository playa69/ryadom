/**
 * Browser storage keys of the web client.
 *
 * localStorage and sessionStorage belong to the origin, and on the production host several clients
 * share one origin: this one under `/app`, and the PWA build (apps/mobile) under `/pwa`. The PWA and
 * the store builds keep their original names (`ryadom_refreshToken`, `ryadom_device`, `ryadom.user`,
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

/** The "Разговор без рук" setting of this browser (localStorage); see client-core/voice/hands-free. */
export const WEB_HANDS_FREE_KEY = `${WEB_STORAGE_PREFIX}hands-free`

/** "Скрывать тексты" of the screen "Память" in this browser (localStorage); see client-core/memory. */
export const WEB_MEMORY_HIDDEN_KEY = `${WEB_STORAGE_PREFIX}memory-hidden`

/** "Не сейчас" on the sheet "Рядом теперь запоминает важное" in this browser (localStorage); see client-core/memory. */
export const WEB_MEMORY_INVITE_DISMISSED_KEY = `${WEB_STORAGE_PREFIX}memory-invite-dismissed`
