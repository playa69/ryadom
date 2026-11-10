import { useEffect, useRef } from 'react'
import { startOrbMotion, type OrbMotionState } from '@ryadom/client-core/voice/orb-motion'
import type { OrbMood } from '@ryadom/client-core/voice/orb-mood'

/**
 * The sphere of the voice screen. It is the interface itself: what it does tells the person who has
 * the floor, so the screen needs no feed to be understood.
 *
 *  - connecting: dim and slow
 *  - idle: breathes, waiting for the person
 *  - listening: cool blue, swells with the person's voice
 *  - thinking: violet, the lit edge travels slowly around while the agent prepares an answer
 *  - speaking: warm, swells with the agent's voice
 *
 * The tone follows the state, and over it the mood: `data-mood` recolours the sphere (sleepy: violet,
 * angry: red, afraid: green) when the agent reports one (REQ-VOICE-10).
 */
export type OrbState = OrbMotionState

export default function VoiceOrb({
  state,
  level,
  mood,
}: {
  state: OrbState
  /** Loudness 0..1 of whoever is making sound now, read on every animation frame. */
  level: () => number
  /** Mood to show over the state's colours; none for the plain look. */
  mood?: OrbMood | null
}) {
  const swell = useRef<HTMLDivElement>(null)
  // The loop must outlive re-renders: restarting it on a new state or a new closure would drop the
  // sphere's current size and angle and make it jump.
  const latest = useRef({ state, level })
  useEffect(() => {
    latest.current = { state, level }
  })

  useEffect(() => {
    const element = swell.current
    if (!element) return
    return startOrbMotion(element, {
      state: () => latest.current.state,
      level: () => latest.current.level(),
    })
  }, [])

  return (
    <div className="rd-orb" data-orb={state} data-mood={mood ?? undefined} aria-hidden="true">
      <div ref={swell} className="rd-orb-swell">
        <div className="rd-breathing">
          <span className="rd-breathing-core" />
        </div>
      </div>
    </div>
  )
}
