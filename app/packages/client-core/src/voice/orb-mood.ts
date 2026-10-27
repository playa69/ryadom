/**
 * The mood of the sphere: which tone the agent reported for the person's last turn (frame `mood`) turns into
 * which colour, how strong it has to be to show, and how long it is held. Shared by the web and the mobile
 * client; the colours themselves are in the stylesheets (`data-mood`).
 */
import type { MoodTone } from '@ryadom/contracts/api/dialogs'

export type OrbMood = 'sleepy' | 'angry' | 'afraid'

const ORB_MOODS: Partial<Record<MoodTone, OrbMood>> = { sleepy: 'sleepy', angry: 'angry', afraid: 'afraid' }

/** Below this strength a reported tone is not shown: the sphere keeps the colour of its state. */
export const MOOD_MIN_INTENSITY = 0.4
/** How long a shown mood is held without a new one before the sphere goes back to the colour of its state. */
export const MOOD_HOLD_MS = 15_000

/** The mood to show for a reported tone, or `null` (neutral, calm, sad or too weak: nothing to show). */
export function orbMoodFor(tone: MoodTone, intensity: number): OrbMood | null {
  return intensity >= MOOD_MIN_INTENSITY ? (ORB_MOODS[tone] ?? null) : null
}

/**
 * Holds the shown mood: `report` sets it from a frame and restarts the hold, `clear` drops it now (the dialog
 * is over). `onChange` gets every new value, including `null` when the hold runs out.
 */
export function createMoodHold(onChange: (mood: OrbMood | null) => void, holdMs = MOOD_HOLD_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    report(tone: MoodTone, intensity: number): void {
      clearTimeout(timer)
      onChange(orbMoodFor(tone, intensity))
      timer = setTimeout(() => onChange(null), holdMs)
    },
    clear(): void {
      clearTimeout(timer)
      onChange(null)
    },
  }
}
