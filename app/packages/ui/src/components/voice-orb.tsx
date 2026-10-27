'use client'

import { useEffect, useRef } from 'react'
import { cn } from 'cn'
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
 * The tone follows the state, and over it the mood (PROTEUS-168): `data-mood` recolours the
 * sphere (sleepy: violet, angry: red, afraid: green) when the agent reports one.
 *
 * Size it with `className` (a width); the shape is always square. The motion is one loop for the whole
 * life of the sphere (client-core's orb-motion), which reaches the DOM through CSSOM, never a `style`
 * attribute: the CSP of the web app forbids those in markup.
 */
export type OrbState = OrbMotionState

function VoiceOrb({
  state,
  level,
  mood,
  className,
}: {
  state: OrbState
  /** Loudness 0..1 of whoever is making sound now, read on every animation frame. */
  level: () => number
  /** Mood to show over the state's colours; none for the plain look. */
  mood?: OrbMood | null
  className?: string
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
    <div data-slot="voice-orb" data-orb={state} data-mood={mood ?? undefined} aria-hidden="true" className={cn('voice-orb', className)}>
      <div ref={swell} className="voice-orb-swell">
        <span className="voice-orb-layer voice-orb-glow" />
        <span className="voice-orb-layer voice-orb-core" />
        <span className="voice-orb-layer voice-orb-ring" />
      </div>
    </div>
  )
}

export { VoiceOrb, type OrbMood }
