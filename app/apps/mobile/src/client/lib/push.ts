import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { PushDataKey } from '@ryadom/contracts/api/notifications'
import { subscribePush, unsubscribePush } from './api'
import { isAppRoute, openRoute } from './nav'
import { isAndroid } from './platform'

/**
 * Notifications on the phone (`add-push-notifications`, `push-notifications`): RuStore Push in the Android build.
 *
 * The switch belongs to this device, like hands-free: it is on once the person turned it on here, and the system is
 * asked for permission only then, never at start-up. A device that has it on subscribes again on every start and
 * sign-in (the subscription belongs to a session, and the token can change), and unsubscribes when the switch goes
 * off or the person signs out. After a sign-out the next account starts with it off.
 *
 * The plugin is native (`android/.../RuStorePushPlugin.java`) and arrives only with a new APK: without it, in the web,
 * the PWA, Telegram and on iOS there is no switch at all, and nothing here calls the plugin.
 */

type ReceivePermission = 'granted' | 'denied' | 'prompt'

interface RuStorePushPlugin {
  checkPermission(): Promise<{ receive: ReceivePermission }>
  requestPermission(): Promise<{ receive: ReceivePermission }>
  /** Rejects with `UNAVAILABLE` when nothing on the phone delivers pushes: no RuStore or VK app, or RuStore never opened. */
  getToken(): Promise<{ token: string; projectId: string; appId: string }>
  deleteToken(): Promise<void>
  openSettings(): Promise<void>
  addListener(
    eventName: 'tokenChanged',
    listener: (event: { token: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'notificationOpened',
    listener: (event: { data: Record<string, string> }) => void,
  ): Promise<PluginListenerHandle>
}

const PLUGIN = 'RuStorePush'
const RuStorePush = registerPlugin<RuStorePushPlugin>(PLUGIN)

/** Present while notifications are on on this device; the subscription id is what signing out removes. */
const STORAGE_KEY = 'ryadom.push'

interface StoredPush {
  subscriptionId: string | null
}

/** The server is not waited on for long when the person leaves: their silence must not hold the sign-out up. */
const UNSUBSCRIBE_TIMEOUT_MS = 3_000

function read(): StoredPush | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredPush) : null
  } catch {
    return null
  }
}

function write(value: StoredPush | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage refused: the switch is simply off on the next start.
  }
}

/** The build can receive notifications: Android with the plugin in its APK. */
export function pushSupported(): boolean {
  return isAndroid() && Capacitor.isPluginAvailable(PLUGIN)
}

export function pushEnabled(): boolean {
  return read() !== null
}

export async function pushPermission(): Promise<ReceivePermission> {
  return (await RuStorePush.checkPermission()).receive
}

export function openPushSettings(): Promise<void> {
  return RuStorePush.openSettings()
}

async function subscribe(): Promise<string> {
  const device = await RuStorePush.getToken()
  const outcome = await subscribePush({ channel: 'rustore', ...device })
  if (!outcome.ok) throw new Error(outcome.code)
  return outcome.data.subscriptionId
}

export type EnablePushOutcome = 'enabled' | 'denied' | 'unavailable' | 'failed'

/** The switch turned on: the system asks only now (Android 13+), then the device subscribes. */
export async function enablePush(): Promise<EnablePushOutcome> {
  if (!pushSupported()) return 'unavailable'
  let receive = await pushPermission()
  if (receive !== 'granted') receive = (await RuStorePush.requestPermission()).receive
  if (receive !== 'granted') return 'denied'
  try {
    write({ subscriptionId: await subscribe() })
    return 'enabled'
  } catch (error) {
    return (error as { code?: unknown }).code === 'UNAVAILABLE' ? 'unavailable' : 'failed'
  }
}

/**
 * The switch turned off, or the person signs out (called before the session is gone: removing the subscription
 * needs it). The token is deleted at RuStore as well, so the phone stops being an address at all. Neither failure
 * keeps the switch on: the server stops sending to an ended session by itself.
 */
export async function disablePush(): Promise<void> {
  const stored = read()
  write(null)
  if (!pushSupported()) return
  if (stored?.subscriptionId) {
    await Promise.race([
      unsubscribePush(stored.subscriptionId).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, UNSUBSCRIBE_TIMEOUT_MS)),
    ])
  }
  await RuStorePush.deleteToken().catch(() => undefined)
}

/** The session ended without this device asking (deleted, blocked, revoked): nothing to tell the server. */
export function forgetPush(): void {
  if (!pushEnabled()) return
  write(null)
  if (pushSupported()) void RuStorePush.deleteToken().catch(() => undefined)
}

/**
 * A device with notifications on subscribes again: the session is new after a sign-in, and the token may have
 * changed. Permission taken back in the system settings leaves the switch to show it; a failure waits for the next
 * start.
 */
async function resubscribe(): Promise<void> {
  if (!pushSupported() || !pushEnabled()) return
  try {
    if ((await pushPermission()) !== 'granted') return
    write({ subscriptionId: await subscribe() })
  } catch {
    // The next start or the next new token tries again.
  }
}

/**
 * For the signed-in app: subscribes again, follows new tokens and opens the screen a tapped notification links to.
 * A tap that started the app is held by the plugin until this listener appears, so it is not lost to the sign-in.
 */
export function initPush(): () => void {
  if (!pushSupported()) return () => undefined
  const handles = [
    RuStorePush.addListener('tokenChanged', () => void resubscribe()),
    RuStorePush.addListener('notificationOpened', ({ data }) => {
      const link = data[PushDataKey.Link]
      if (isAppRoute(link)) openRoute(link)
    }),
  ]
  void resubscribe()
  return () => {
    for (const handle of handles) void handle.then((h) => h.remove())
  }
}
