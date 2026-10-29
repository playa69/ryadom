import { moodColor } from '@ryadom/client-core/diary'
import type { MoodLevel } from '@ryadom/contracts/api/diary'

/** Mouth of each level: from a frown to a wide smile. Our own drawing, not a system emoji. */
const MOUTH: Record<MoodLevel, string> = {
  1: 'M14 29 Q20 22 26 29',
  2: 'M14 28 Q20 25 26 28',
  3: 'M14 27 L26 27',
  4: 'M14 26 Q20 31 26 26',
  5: 'M13 25 Q20 35 27 25',
}

export function MoodFace({ mood, size = 44, muted = false }: { mood: MoodLevel; size?: number; muted?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
      className={muted ? 'opacity-40 grayscale transition-opacity' : 'transition-opacity'}
    >
      <circle cx="20" cy="20" r="19" fill={moodColor(mood)} />
      <circle cx="14" cy="16" r="2" fill="#0b1226" />
      <circle cx="26" cy="16" r="2" fill="#0b1226" />
      <path d={MOUTH[mood]} fill="none" stroke="#0b1226" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}
