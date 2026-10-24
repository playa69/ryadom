import { Capacitor } from '@capacitor/core'
import type { PushChannel } from '@ryadom/contracts/api/notifications'
import { createNotificationSubscription, getNotificationSettings } from './api'
import { isIos, isNative, isStandalone, isWebBuild } from './platform'
import { isTelegramMiniApp, telegramWebApp } from './telegram'

/**
 * How a device is connected to the mood reminder (`REQ-WELL-04`). One channel per device:
 *
 * - `telegram`: the Mini App; the bot writes once the person allowed it (`requestWriteAccess`);
 * - `web_push`: the PWA or a browser with a service worker and Push;
 * - `native_local`: a native build with the local-notifications plugin (it is not in the current APK,
 *   so there the reminder row is simply not shown, see `reminderChannel`);
 * - `none`: nothing to connect to, or iPhone outside an installed PWA (`iphone-install`).
 *
 * The system permission is asked for only here, only after the person said "Да" on the card: never at launch.
 */

export type ReminderChannel = PushChannel | 'iphone-install' | 'none'

export type EnableResult = 'ok' | 'denied' | 'unsupported' | 'unavailable'

/** The native plugin of local notifications is in this build (a build before it must not show the row). */
export function hasLocalNotificationPlugin(): boolean {
  return isNative() && Capacitor.isPluginAvailable('LocalNotifications')
}

export function reminderChannel(): ReminderChannel {
  if (isTelegramMiniApp()) return 'telegram'
  if (isNative()) return hasLocalNotificationPlugin() ? 'native_local' : 'none'
  if (!isWebBuild()) return 'none'
  const pushable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (pushable) return 'web_push'
  // Safari on iPhone has Web Push only for a PWA added to the Home Screen.
  return isIos() && !isStandalone() ? 'iphone-install' : 'none'
}

/** Whether the system has already refused notifications for this app (the row then says how to allow them). */
export function notificationsBlocked(): boolean {
  return reminderChannel() === 'web_push' && Notification.permission === 'denied'
}

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function requestTelegramWriteAccess(): Promise<boolean> {
  const app = telegramWebApp() as unknown as { requestWriteAccess?: (cb: (allowed: boolean) => void) => void } | null
  if (!app?.requestWriteAccess) return Promise.resolve(false)
  return new Promise((resolve) => app.requestWriteAccess!((allowed) => resolve(allowed)))
}

async function enableWebPush(): Promise<EnableResult> {
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  const settings = await getNotificationSettings()
  if (!settings.vapidPublicKey) return 'unavailable'
  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(settings.vapidPublicKey),
  })
  const outcome = await createNotificationSubscription({
    channel: 'web_push',
    endpoint: subscription.endpoint,
    keys: { p256dh: toBase64Url(subscription.getKey('p256dh')), auth: toBase64Url(subscription.getKey('auth')) },
    deviceLabel: isStandalone() ? 'PWA' : 'Браузер',
  })
  if (!outcome.ok) return 'unavailable'
  return 'ok'
}

/**
 * Connects this device after the person's "Да": the system prompt (or the Telegram permission) and the
 * subscription. 'denied' means the person said no to the system; the setting on the server stays.
 */
export async function enableReminderOnDevice(): Promise<EnableResult> {
  const channel = reminderChannel()
  try {
    if (channel === 'telegram') {
      const allowed = await requestTelegramWriteAccess()
      if (!allowed) return 'denied'
      const outcome = await createNotificationSubscription({ channel: 'telegram', deviceLabel: 'Telegram' })
      return outcome.ok ? 'ok' : 'unavailable'
    }
    if (channel === 'web_push') return await enableWebPush()
    return 'unsupported'
  } catch {
    return 'unavailable'
  }
}

/** Whether this browser already holds a push subscription (so a switched-on row needs no new prompt). */
export async function deviceIsSubscribed(): Promise<boolean> {
  if (reminderChannel() !== 'web_push' || Notification.permission !== 'granted') return false
  try {
    const registration = await navigator.serviceWorker.ready
    return (await registration.pushManager.getSubscription()) !== null
  } catch {
    return false
  }
}
