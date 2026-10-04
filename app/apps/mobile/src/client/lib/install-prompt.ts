import { isWebBuild } from './platform'

/**
 * `beforeinstallprompt` fires once, at an arbitrary moment after load, so the listener is
 * installed at module level rather than inside a component. iOS Safari does not support the
 * event at all: there InstallBanner shows the "Share -> Add to Home Screen" hint instead.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
let listeners: Array<() => void> = []

function notify(): void {
  listeners.forEach((fn) => fn())
}

if (isWebBuild() && typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null
}

export function onInstallPromptChange(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((listener) => listener !== fn)
  }
}

/** `false` when the prompt is unavailable or the person declined. */
export async function triggerInstallPrompt(): Promise<boolean> {
  const prompt = deferredPrompt
  if (!prompt) return false
  await prompt.prompt()
  const choice = await prompt.userChoice
  deferredPrompt = null
  notify()
  return choice.outcome === 'accepted'
}
