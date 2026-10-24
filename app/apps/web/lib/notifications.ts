import type { RyadomClient } from '@ryadom/client-core/client'
import { appPath } from './base-path'

/**
 * Web Push of the browser (`REQ-WELL-02`). The system permission is asked only from here, and only
 * after the person said "Да" to the reminder question: never at launch or in onboarding.
 */

export type PushSupport = 'supported' | 'unsupported' | 'needs-install'

/** Safari on an iPhone has Web Push only for an app added to the Home Screen. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
  if (ios && !standalone) return 'needs-install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported'
  }
  return 'supported'
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export type PushOutcome = 'subscribed' | 'denied' | 'unsupported' | 'unavailable'

/**
 * Registers the worker, asks the browser for permission and hands the subscription to the server.
 * `denied` leaves the setting on the server as it is: other devices keep their reminders.
 */
export async function enablePush(client: RyadomClient, vapidPublicKey: string | null): Promise<PushOutcome> {
  if (pushSupport() !== 'supported') return 'unsupported'
  if (!vapidPublicKey) return 'unavailable'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  try {
    const registration = await navigator.serviceWorker.register(appPath('/sw.js'), { scope: appPath('/') })
    await navigator.serviceWorker.ready
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(vapidPublicKey),
      }))
    const json = subscription.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'unavailable'
    const result = await client.createNotificationSubscription({
      channel: 'web_push',
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      deviceLabel: 'Браузер',
    })
    return result.ok ? 'subscribed' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** The reminder opened the diary: `?from=reminder&delivery=ID` tells the server, which counts unopened ones. */
export function reportReminderOpened(client: RyadomClient, search: URLSearchParams): void {
  if (search.get('from') !== 'reminder') return
  const id = Number(search.get('delivery'))
  if (Number.isInteger(id) && id > 0) void client.notificationOpened(id).catch(() => undefined)
}
