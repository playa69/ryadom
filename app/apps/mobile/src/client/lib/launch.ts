import { notificationOpened } from './api'
import { openRoute } from './nav'

/**
 * Where the app was opened from. A reminder (Web Push, the bot's button) and the PWA shortcut open the
 * diary: by address (`/diary/?from=reminder&delivery=12`, `/diary/?checkin=1`) when the app starts, or by
 * a message from the service worker when it is already open. The route is ours alone (`isAppRoute`).
 */

/** The reminder that brought the person here is reported once, so the server can count it as opened. */
function reportOpened(deliveryId: number): void {
  if (Number.isInteger(deliveryId) && deliveryId > 0) void notificationOpened(deliveryId).catch(() => undefined)
}

/** Reads the address the app started on. Returns true when it opened the diary. */
export function handleLaunchUrl(search: string, pathname: string): boolean {
  const params = new URLSearchParams(search)
  const fromReminder = params.get('from') === 'reminder'
  const checkin = params.get('checkin') === '1'
  const onDiary = /\/diary\/?$/.test(pathname)
  if (!fromReminder && !checkin && !onDiary) return false
  if (fromReminder) reportOpened(Number(params.get('delivery')))
  openRoute('/diary/')
  return true
}

export function initLaunchRouting(): () => void {
  handleLaunchUrl(window.location.search, window.location.pathname)
  function onMessage(event: MessageEvent) {
    const data = event.data as { type?: string; deliveryId?: number } | undefined
    if (data?.type !== 'OPEN_DIARY') return
    if (data.deliveryId) reportOpened(data.deliveryId)
    openRoute('/diary/')
  }
  navigator.serviceWorker?.addEventListener('message', onMessage)
  return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
}
