import { Browser } from '@capacitor/browser'
import { getWebUrl } from './env'
import { isNative } from './platform'

/**
 * Legal documents live on the site, not in the app: a lawyer edits one copy and both platforms
 * show the same revision. Built as functions because the dev build can switch environments at
 * runtime.
 */
export const termsUrl = (): string => `${getWebUrl()}/terms`
export const privacyUrl = (): string => `${getWebUrl()}/privacy`

/** Outbound link: Custom Tabs on a phone, a new tab in a browser. */
export async function openExternal(url: string): Promise<void> {
  if (!url) return
  if (!isNative()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  try {
    await Browser.open({ url })
  } catch {
    window.open(url, '_blank')
  }
}
