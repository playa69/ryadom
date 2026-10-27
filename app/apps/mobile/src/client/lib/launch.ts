import { openRoute } from './nav'

/**
 * Where the app was opened from. The PWA shortcut «Отметить настроение» opens the diary by address
 * (`/diary/?checkin=1`) when the app starts. The route is ours alone (`isAppRoute`).
 */

/** Reads the address the app started on. Returns true when it opened the diary. */
export function handleLaunchUrl(search: string, pathname: string): boolean {
  const checkin = new URLSearchParams(search).get('checkin') === '1'
  const onDiary = /\/diary\/?$/.test(pathname)
  if (!checkin && !onDiary) return false
  openRoute('/diary/')
  return true
}

export function initLaunchRouting(): () => void {
  handleLaunchUrl(window.location.search, window.location.pathname)
  return () => undefined
}
