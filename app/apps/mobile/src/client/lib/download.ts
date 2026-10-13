import { isNative } from './platform'

/**
 * Hands a file made on the device to the person. A browser (the PWA) saves it through a link with
 * `download`. The store builds have no file plugin, and a WebView ignores such links, so there the
 * system share sheet is tried; where it cannot take files the answer is `false`, and the screen says
 * where the file can be had instead. The content is never written anywhere else on the way.
 */
export async function saveTextFile(name: string, text: string, type = 'application/json'): Promise<boolean> {
  if (isNative()) {
    try {
      const file = new File([text], name, { type })
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name })
        return true
      }
    } catch (error) {
      // The person closed the share sheet: the file was offered, which is what they asked for.
      if (error instanceof DOMException && error.name === 'AbortError') return true
    }
    return false
  }
  const url = URL.createObjectURL(new Blob([text], { type }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    // Framework7 takes every other link in the document for a route and cancels its default action.
    link.className = 'external'
    document.body.append(link)
    link.click()
    link.remove()
  } finally {
    // The click has started the download; the object URL is no longer needed.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return true
}
