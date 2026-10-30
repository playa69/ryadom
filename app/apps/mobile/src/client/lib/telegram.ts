/**
 * The Telegram Mini App: this same web build opened from the bot (`@slyshu_ryadom_bot`). Telegram puts
 * its launch data in the address (`#tgWebAppData=…`) and its script keeps a copy in sessionStorage, so
 * a reload inside Telegram is still the Mini App. Everything Telegram-specific lives here, behind
 * `isTelegramMiniApp()`: in a browser none of it loads.
 *
 * Must not import platform-adapter.ts, api.ts or auth.ts: platform-adapter reads `isTelegramLaunch()`.
 */

type TelegramWebApp = typeof import('@twa-dev/sdk').default

/** The app's background (index.html, tokens.css): Telegram's header and the area around the page take it. */
const BACKGROUND = '#00051a'

/** The person signed out inside this Mini App launch: the next screen must not sign them back in. */
const SIGNED_OUT_KEY = 'ryadom.telegram.signedOut'

let webApp: TelegramWebApp | null = null

/** Whether the page was opened as the Mini App. Decided from the address, before Telegram's script loads. */
export function isTelegramLaunch(): boolean {
  try {
    if (/[#&]tgWebApp(Data|Platform|Version)=/.test(window.location.hash)) return true
    return (window.sessionStorage.getItem('__telegram__initParams') ?? '').includes('tgWebAppData')
  } catch {
    return false
  }
}

/**
 * Loads Telegram's script and sets the Mini App up: full height, no swipe-down-to-close (a conversation
 * is long, and a stray swipe would end it), Telegram's chrome in the app's colours. Null in a browser,
 * and also when Telegram gave no signed launch data, since then there is nobody to sign in.
 */
export async function initTelegram(): Promise<TelegramWebApp | null> {
  if (!isTelegramLaunch()) return null
  try {
    await import('@twa-dev/sdk')
    const app = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp
    if (!app?.initData) return null
    webApp = app
    app.ready()
    app.expand()
    if (app.isVersionAtLeast('6.1')) {
      app.setHeaderColor(BACKGROUND)
      app.setBackgroundColor(BACKGROUND)
    }
    if (app.isVersionAtLeast('7.7')) app.disableVerticalSwipes()
    return app
  } catch {
    return null
  }
}

export function isTelegramMiniApp(): boolean {
  return webApp !== null
}

export function telegramWebApp(): TelegramWebApp | null {
  return webApp
}

/** What Telegram signed for this launch: the server checks it and finds the account by it. */
export function telegramInitData(): string | null {
  return webApp?.initData || null
}

/**
 * The label of the link the Mini App was opened by (`t.me/<bot>?startapp=<label>`), for the report of where people
 * come from. Passed on as written: the analytics layer keeps it only if it is a short slug.
 */
export function telegramStartParam(): string | null {
  return webApp?.initDataUnsafe.start_param || null
}

/** The first name in the person's Telegram profile: a suggestion for how the agent calls them, never sent by itself. */
export function telegramFirstName(): string {
  return webApp?.initDataUnsafe.user?.first_name?.trim() ?? ''
}

/** While a conversation is on, closing the Mini App asks first: the dialog would be cut off. */
export function setTelegramClosingConfirmation(enabled: boolean): void {
  if (!webApp?.isVersionAtLeast('6.2')) return
  if (enabled) webApp.enableClosingConfirmation()
  else webApp.disableClosingConfirmation()
}

/**
 * The person signed out: until the Mini App is closed (sessionStorage lives as long as the launch) the
 * app stays on the first screen instead of signing them straight back in with Telegram.
 */
export function markTelegramSignedOut(signedOut: boolean): void {
  try {
    if (signedOut) window.sessionStorage.setItem(SIGNED_OUT_KEY, '1')
    else window.sessionStorage.removeItem(SIGNED_OUT_KEY)
  } catch {
    // Without storage the next screen signs back in: the account is still the person's own.
  }
}

export function wasTelegramSignedOut(): boolean {
  try {
    return window.sessionStorage.getItem(SIGNED_OUT_KEY) === '1'
  } catch {
    return false
  }
}
