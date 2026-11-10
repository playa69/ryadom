import type { MicDetail } from './capture'

export type MicPermission = 'granted' | 'denied' | 'prompt'

/**
 * The browser's own answer about the microphone, without asking the person anything. `null` where the
 * browser cannot say (Safari does not know the `microphone` name): there the only way to find out is to ask.
 */
export async function queryMicPermission(): Promise<MicPermission | null> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state
  } catch {
    return null
  }
}

/**
 * Calls `onChange` whenever the person flips the switch in the browser's settings while the page is open.
 * Returns the function that stops listening; a no-op where the browser cannot say.
 */
export function watchMicPermission(onChange: (state: MicPermission) => void): () => void {
  let stop = () => {}
  let live = true
  navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((status) => {
      if (!live) return
      const listener = () => onChange(status.state)
      status.addEventListener('change', listener)
      stop = () => status.removeEventListener('change', listener)
    })
    .catch(() => undefined)
  return () => {
    live = false
    stop()
  }
}

/** The words for a microphone that did not open for a reason that is not a refusal. */
export const MIC_FAILURE_TEXT: Record<Exclude<MicDetail, 'not_allowed' | 'blocked'>, string> = {
  not_found: 'Микрофон не найден. Подключи его — или пиши текстом.',
  not_readable: 'Микрофон занят другим приложением. Закрой его там — или пиши текстом.',
  security: 'Здесь микрофон включить нельзя: страница открыта не по защищённому адресу. Можно писать текстом.',
  other: 'Не получилось включить микрофон. Можно писать текстом.',
}
