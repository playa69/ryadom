import { Capacitor } from '@capacitor/core'

/** The app runs inside the native shell (store build) rather than in a browser. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

export function isAndroid(): boolean {
  return Capacitor.getPlatform() === 'android'
}

export function isIosNative(): boolean {
  return Capacitor.getPlatform() === 'ios'
}

/** Web build (`vite build --mode web`): a PWA or plain web app, not a store build. */
export function isWebBuild(): boolean {
  return import.meta.env.MODE === 'web'
}

/** The PWA is installed and opened as an app rather than as a browser tab. */
export function isStandalone(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  // iOS Safari does not support display-mode, only this non-standard field.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** iPadOS 13+ claims to be a Mac in the UA; the touchscreen, which a Mac lacks, tells them apart. */
export function isIos(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

/**
 * In-app browser of a social network or messenger: it has no "add to home screen" item, so
 * installing requires opening the page in the system browser first.
 */
export function isInAppBrowser(): boolean {
  return /Telegram|VKAndroidApp|vkclient|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent)
}
