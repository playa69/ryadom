/**
 * The "Разговор без рук" setting and the words of the hands-free voice screen, shared by the web and
 * the mobile client. The setting belongs to the device, not the account: whether a phone may listen on
 * its own is decided where it lies. Each client passes its own storage key (see their storage keys).
 */

/** On unless the person turned it off here. Storage that is missing or refuses means the default. */
export function readHandsFree(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'off'
  } catch {
    return true
  }
}

export function writeHandsFree(key: string, on: boolean): void {
  try {
    if (on) localStorage.removeItem(key)
    else localStorage.setItem(key, 'off')
  } catch {
    // Not remembered: the next visit starts with the default, which is harmless.
  }
}

/** Why the microphone is paused: it says what brings it back. */
export type MicPause = 'manual' | 'idle' | 'background'

/** Under the sphere in hands-free mode, by what is happening. */
export const HANDS_FREE_HINT = {
  idle: 'Говори, я слушаю',
  listening: 'Слушаю…',
  thinking: 'Думаю…',
  speaking: 'Просто начни говорить, чтобы перебить',
  paused: 'Микрофон на паузе',
  /** Two minutes with nothing said: the microphone went quiet by itself. */
  idlePaused: 'Я рядом. Скажи что-нибудь или нажми, чтобы продолжить',
} as const

export function pausedHint(reason: MicPause): string {
  return reason === 'idle' ? HANDS_FREE_HINT.idlePaused : HANDS_FREE_HINT.paused
}
