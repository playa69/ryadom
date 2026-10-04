/**
 * Motion of the voice sphere, shared by the web and the mobile client.
 *
 * Everything that moves is integrated from the real frame time. Nothing here counts frames and nothing
 * is a CSS animation whose duration depends on the state: changing `animation-duration` on a running
 * animation, or restarting a loop when the state changes, makes the picture jump to a new phase. Here
 * the only things that change on a state change are targets, and the values glide to them.
 *
 * The component writes the result as unitless CSS custom properties (see `startOrbMotion`); the
 * stylesheet decides how far each of them moves the sphere.
 */

export type OrbMotionState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking'

/** Seconds for one breath. Slow on purpose: the sphere is there to calm, not to draw the eye. */
const BREATH_PERIOD: Record<OrbMotionState, number> = {
  connecting: 12,
  idle: 8,
  listening: 6.5,
  thinking: 5.5,
  speaking: 6.5,
}
/** How long the breathing takes to change its pace after a state change. */
const PACE_TAU = 1.6

/** Degrees per second of the lit edge while thinking: a full turn in 12 s. */
const TURN_SPEED = 30
/** On the way back to rest the edge may go on a little faster, but only forwards, never back. */
const SETTLE_SPEED = 60
/** The turn speed follows its target with this lag, so it picks up and stops without a jolt. */
const TURN_TAU = 0.5
/** Time constant of the approach to rest. Long enough against `TURN_TAU` to be overdamped: no overshoot. */
const SETTLE_TAU = 2.2
/** Within this many degrees of the rest position the edge counts as home. */
const HOME_TOLERANCE = 2

/** The core lags the halo by this part of a breath, so the light seems to swell inside the ring. */
const CORE_LAG = 0.05

/**
 * Two followers in a row. The first rises quickly and falls slowly, which fills the gaps between
 * syllables, so a phrase is one swell and not a flicker. The second is symmetric and slow: it rounds the
 * corners the first leaves, so the sphere starts and stops moving without a kink.
 */
const ATTACK_TAU = 0.12
const RELEASE_TAU = 0.5
const GLIDE_TAU = 0.2

/** A frame that took longer than this (a hidden tab, a stall) is treated as this long. */
const MAX_FRAME = 0.05

export interface OrbFrame {
  /** Smoothed loudness 0..1. */
  level: number
  /** Where the halo and the ring are in their breath, 0..1. */
  breath: number
  /** The same for the core, a little behind. */
  breathLag: number
  /** Degrees 0..360 of the lit edge; wraps seamlessly. */
  turn: number
}

/** Whether the sphere follows somebody's voice in this state. */
export function carriesVoice(state: OrbMotionState): boolean {
  return state === 'listening' || state === 'speaking'
}

/** Weight of the new sample for a frame of `dt` seconds: the same smoothing at 30, 60 or 144 fps. */
function blend(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau)
}

export class OrbMotion {
  private fast = 0
  private level = 0
  /** Position in the breath, in cycles. Starts mid-way, where the stylesheet's static look is. */
  private cycles = 0.25
  private pace: number
  private turn = 0
  private spin = 0

  constructor(state: OrbMotionState = 'connecting') {
    this.pace = 1 / BREATH_PERIOD[state]
  }

  /** Advances by `dt` seconds. `raw` is the loudness of whoever has the floor, ignored when nobody has. */
  step(state: OrbMotionState, raw: number, dt: number): OrbFrame {
    const span = Math.min(Math.max(dt, 0), MAX_FRAME)

    const heard = carriesVoice(state) && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
    this.fast += (heard - this.fast) * blend(span, heard > this.fast ? ATTACK_TAU : RELEASE_TAU)
    this.level += (this.fast - this.level) * blend(span, GLIDE_TAU)

    this.pace += (1 / BREATH_PERIOD[state] - this.pace) * blend(span, PACE_TAU)
    this.cycles = (this.cycles + this.pace * span) % 1

    let spinTarget = TURN_SPEED
    if (state !== 'thinking') {
      // Head for the rest position ahead of the edge, slowing down as it gets close.
      const ahead = this.turn < HOME_TOLERANCE ? 0 : 360 - this.turn
      spinTarget = Math.min(SETTLE_SPEED, ahead / SETTLE_TAU)
    }
    this.spin += (spinTarget - this.spin) * blend(span, TURN_TAU)
    this.turn = (this.turn + this.spin * span) % 360

    const wave = (at: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * at)
    return {
      level: this.level,
      breath: wave(this.cycles),
      breathLag: wave(this.cycles - CORE_LAG),
      turn: this.turn,
    }
  }
}

export interface OrbMotionSource {
  state(): OrbMotionState
  /** Loudness 0..1; asked on a frame only when the state carries a voice. */
  level(): number
}

const num = (value: number, digits: number) => value.toFixed(digits)

/**
 * Drives `element` frame by frame until the returned function is called. The values go through CSSOM,
 * never a `style` attribute: the CSP of the web app forbids those in markup.
 *
 * Under the system's reduced-motion setting nothing runs and the stylesheet's static look stays.
 */
export function startOrbMotion(element: HTMLElement, source: OrbMotionSource): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => undefined

  const motion = new OrbMotion(source.state())
  let frame = 0
  let before: number | undefined

  const tick = (now: number) => {
    const dt = before === undefined ? 0 : (now - before) / 1000
    before = now
    const state = source.state()
    const out = motion.step(state, carriesVoice(state) ? source.level() : 0, dt)
    element.style.setProperty('--orb-level', num(out.level, 4))
    element.style.setProperty('--orb-breath', num(out.breath, 4))
    element.style.setProperty('--orb-breath-lag', num(out.breathLag, 4))
    element.style.setProperty('--orb-turn', num(out.turn, 3))
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(frame)
    for (const name of ['--orb-level', '--orb-breath', '--orb-breath-lag', '--orb-turn']) {
      element.style.removeProperty(name)
    }
  }
}
