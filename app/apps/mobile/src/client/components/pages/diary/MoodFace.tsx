import type { MoodLevel } from '@ryadom/contracts/api/diary'
import { moodColor } from '@ryadom/client-core/diary'

/** Features of the five faces, drawn on a 48 × 48 grid. The mouth goes from a frown to a wide smile. */
const MOUTHS: Record<MoodLevel, { d: string; fill?: boolean }> = {
  1: { d: 'M15 35 Q24 26 33 35' },
  2: { d: 'M16 33 Q24 29 32 33' },
  3: { d: 'M16 31 L32 31' },
  4: { d: 'M15 29 Q24 37 33 29' },
  5: { d: 'M14 28 Q24 42 34 28 Z', fill: true },
}

const INK = '#00051a'

/** The face without its own `<svg>`, so the chart can place it among its marks. */
export function MoodFaceShape({ level }: { level: MoodLevel }) {
  const mouth = MOUTHS[level]
  return (
    <>
      <circle cx="24" cy="24" r="22" fill={moodColor(level)} />
      <circle cx="17" cy="19" r="2.4" fill={INK} />
      <circle cx="31" cy="19" r="2.4" fill={INK} />
      <path
        d={mouth.d}
        fill={mouth.fill ? INK : 'none'}
        stroke={INK}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  )
}

/** A mood level as a face in the level's colour: the diary has no emoji, the faces are ours. */
export default function MoodFace({ level, size = 44 }: { level: MoodLevel; size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false">
      <MoodFaceShape level={level} />
    </svg>
  )
}
