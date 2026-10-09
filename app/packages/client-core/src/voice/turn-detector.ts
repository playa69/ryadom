/**
 * Hands-free turns: the microphone stays open for the whole voice session and this decides, from the
 * loudness alone, when the person starts speaking, when they have finished, and when they talk over the
 * agent. It is a pure state machine fed with samples (`step`), so the tests drive it with a made-up
 * signal; `watchTurns` is the loop that feeds it from the real microphone and player.
 *
 * v1 is an energy detector with a threshold that follows the room's noise floor. The floor is the
 * quietest the microphone has been over the last few seconds (minimum statistics): speech always has
 * gaps between words that reach down to the room, steady noise has none, so a fan or a street raises the
 * floor and a voice does not. A neural VAD (Silero on WASM) can replace the threshold later without
 * changing the events.
 */

/**
 * The longest turn. The agent drops audio beyond `VOICE_TURN_MAX_SECONDS` (300 by default), so the
 * client closes the turn itself before that: the person gets an answer to everything they said.
 */
export const MAX_TURN_MS = 300_000

/**
 * Audio kept from before the turn starts. The start is only recognized after `startMs` of voice, and
 * the first syllable comes before that: the buffer covers the detection time plus ~300 ms of lead.
 */
export const PRE_ROLL_MS = 600

export interface TurnDetectorOptions {
  /** Voice for this long starts a turn. */
  startMs: number
  /** Voice over the agent for this long interrupts it. The agent must fall silent within 300 ms. */
  bargeInMs: number
  /** Silence for this long ends a turn. */
  endSilenceMs: number
  /**
   * Upper bound for `endSilenceMs` as it adapts: a person who comes back right after a turn was closed
   * was cut off mid-thought, so the pause they are given grows, up to this.
   */
  maxEndSilenceMs: number
  /** A turn is closed by force after this long; it starts with `PRE_ROLL_MS` of earlier audio. */
  maxTurnMs: number
  /** No turn for this long, with nobody else speaking, pauses the microphone. */
  idleMs: number
}

export const TURN_DEFAULTS: TurnDetectorOptions = {
  startMs: 250,
  bargeInMs: 250,
  endSilenceMs: 900,
  maxEndSilenceMs: 2000,
  maxTurnMs: MAX_TURN_MS - PRE_ROLL_MS,
  idleMs: 120_000,
}

export interface TurnSample {
  /** Milliseconds on any monotonic clock. */
  now: number
  /** Loudness of the microphone, 0..1 (`VoiceCapture.level`). */
  level: number
  /** Loudness of the agent's voice being played, 0..1 (`VoicePlayer.level` / `ReplyVoice.level`). */
  agentLevel: number
  /** The agent is audible: the microphone may be hearing it through the speaker. */
  agentSpeaking: boolean
  /** The agent is thinking or speaking: silence now is not the person being idle. */
  busy: boolean
}

export type TurnEvent =
  { type: 'start'; bargeIn: boolean } | { type: 'end'; reason: 'silence' | 'limit' } | { type: 'idle' }

/** The quietest a threshold gets: below it is hiss, not a voice, in any room. */
const MIN_THRESHOLD = 0.06
/** And the loudest: a very noisy room still lets a voice close to the phone through. */
const MAX_THRESHOLD = 0.5
/** A voice is this many times louder than the noise floor, plus a margin. */
const FLOOR_RATIO = 2.5
const FLOOR_MARGIN = 0.04
/** The floor is the quietest level over this window, then smoothed: down fast, up slower. */
const FLOOR_WINDOW_MS = 3000
const FLOOR_FALL_TAU = 300
const FLOOR_RISE_TAU = 1000
/**
 * Right after the microphone opens the room is measured first, and nothing starts a turn. Someone who
 * is already talking would be measured as the room, so what is measured is capped: a noisy room still
 * gets a threshold above its noise, and a voice still passes it.
 */
const CALIBRATION_MS = 300
const CALIBRATION_FLOOR_MAX = 0.08
/** Once speaking, a voice may dip this far below the threshold and still count: no chatter at the edge. */
const RELEASE_RATIO = 0.7
/** Gaps shorter than this between syllables do not restart the count to a turn start. */
const START_GAP_MS = 150

/**
 * Echo of the agent's own voice. `echoCancellation` removes most of it, but not all, and on iOS it is
 * unreliable for speech synthesis. While the agent is audible the threshold is raised, and the
 * microphone must also be louder than a part of what is being played: the person's voice is close,
 * the echo is the speaker heard from a distance and is quieter than the signal sent to it.
 */
const ECHO_THRESHOLD_RATIO = 1.8
const ECHO_PLAYBACK_RATIO = 0.6
/** The echo outlives the playback by the room's reverberation and the output latency. */
const ECHO_TAIL_MS = 300
/** The playback level is held at its peak and decays with this, so echo arriving late still compares. */
const ECHO_PEAK_TAU = 250

/** A person who speaks again within this after a turn ended was cut off, not done. */
const RESUME_WINDOW_MS = 1500
/** How much the allowed pause grows each time that happens. */
const END_SILENCE_STEP_MS = 300

type Phase = 'silence' | 'speech'

export class TurnDetector {
  private readonly options: TurnDetectorOptions
  private phase: Phase = 'silence'
  private floor = 0.02
  /** Recent levels as [time, level], oldest first, for the floor's minimum. */
  private recent: Array<[number, number]> = []
  private calibrateUntil: number | null = null
  private before: number | null = null
  /** When the current run of voice began, and when voice was last heard. */
  private voicedSince: number | null = null
  private lastVoiced = 0
  private turnStarted = 0
  private lastEnded: number | null = null
  private echoUntil = 0
  private agentPeak = 0
  private lastActivity: number | null = null
  private idleSent = false
  private endSilence: number

  constructor(options: Partial<TurnDetectorOptions> = {}) {
    this.options = { ...TURN_DEFAULTS, ...options }
    this.endSilence = this.options.endSilenceMs
  }

  /** Whether a turn is in progress. */
  get speaking(): boolean {
    return this.phase === 'speech'
  }

  /** The pause that ends a turn right now: it grows when the person keeps being cut off. */
  get endSilenceMs(): number {
    return this.endSilence
  }

  /** The level a voice has to reach now, for tests and for a debugging overlay. */
  threshold(now: number): number {
    const base = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, this.floor * FLOOR_RATIO + FLOOR_MARGIN))
    return now < this.echoUntil ? Math.min(1, base * ECHO_THRESHOLD_RATIO) : base
  }

  /**
   * Forgets the turn in progress and the time spent silent, keeps what it learned about the room. For
   * a microphone that is paused and taken back, or a turn closed from outside.
   */
  reset(now: number): void {
    this.phase = 'silence'
    this.voicedSince = null
    this.lastActivity = now
    this.idleSent = false
    this.lastEnded = null
    this.recent = []
    this.calibrateUntil = now + CALIBRATION_MS
  }

  /** Follows the quietest level of the last few seconds, whoever is speaking. */
  private learnFloor(now: number, level: number, dt: number): void {
    this.recent.push([now, level])
    while (this.recent.length > 0 && this.recent[0]![0] < now - FLOOR_WINDOW_MS) this.recent.shift()
    let quietest = level
    for (const [, value] of this.recent) quietest = Math.min(quietest, value)
    if (this.calibrateUntil !== null && now < this.calibrateUntil) {
      this.floor = Math.min(quietest, CALIBRATION_FLOOR_MAX)
      return
    }
    const tau = quietest < this.floor ? FLOOR_FALL_TAU : FLOOR_RISE_TAU
    this.floor += (quietest - this.floor) * (1 - Math.exp(-dt / tau))
  }

  step(sample: TurnSample): TurnEvent | null {
    const { now } = sample
    const level = Number.isFinite(sample.level) ? Math.min(1, Math.max(0, sample.level)) : 0
    const agentLevel = Number.isFinite(sample.agentLevel) ? Math.min(1, Math.max(0, sample.agentLevel)) : 0
    const dt = this.before === null ? 0 : Math.max(0, now - this.before)
    this.before = now
    if (this.lastActivity === null) this.lastActivity = now
    if (this.calibrateUntil === null) this.calibrateUntil = now + CALIBRATION_MS
    this.learnFloor(now, level, dt)

    this.agentPeak = Math.max(agentLevel, this.agentPeak * Math.exp(-dt / ECHO_PEAK_TAU))
    if (sample.agentSpeaking) this.echoUntil = now + ECHO_TAIL_MS
    const echo = now < this.echoUntil

    if (this.phase === 'speech') return this.inTurn(now, level)
    if (sample.busy) this.lastActivity = now
    if (now < this.calibrateUntil) return null

    const voiced = level > this.threshold(now) && (!echo || level > this.agentPeak * ECHO_PLAYBACK_RATIO)
    if (!voiced) {
      if (this.voicedSince !== null && now - this.lastVoiced > START_GAP_MS) this.voicedSince = null
      if (!this.idleSent && !sample.busy && now - this.lastActivity >= this.options.idleMs) {
        this.idleSent = true
        return { type: 'idle' }
      }
      return null
    }

    this.lastVoiced = now
    this.lastActivity = now
    this.idleSent = false
    if (this.voicedSince === null) this.voicedSince = now
    const bargeIn = echo
    if (now - this.voicedSince < (bargeIn ? this.options.bargeInMs : this.options.startMs)) return null

    // Back so soon after the last turn closed: that one was cut mid-thought, give longer pauses.
    if (this.lastEnded !== null && this.voicedSince - this.lastEnded < RESUME_WINDOW_MS) {
      this.endSilence = Math.min(this.options.maxEndSilenceMs, this.endSilence + END_SILENCE_STEP_MS)
    }
    this.phase = 'speech'
    this.turnStarted = now
    return { type: 'start', bargeIn }
  }

  private inTurn(now: number, level: number): TurnEvent | null {
    // The agent has been silenced by now, so its echo rules no longer apply; only the hysteresis does.
    if (level > this.threshold(now) * RELEASE_RATIO) this.lastVoiced = now
    if (now - this.turnStarted >= this.options.maxTurnMs) return this.end(now, 'limit')
    if (now - this.lastVoiced >= this.endSilence) return this.end(now, 'silence')
    return null
  }

  private end(now: number, reason: 'silence' | 'limit'): TurnEvent {
    this.phase = 'silence'
    this.voicedSince = null
    this.lastActivity = now
    this.lastEnded = now
    return { type: 'end', reason }
  }
}

export interface TurnSources {
  /** Microphone loudness, 0..1. */
  level(): number
  agentLevel(): number
  agentSpeaking(): boolean
  busy(): boolean
  onEvent(event: TurnEvent): void
}

/** How often the loudness is read: often enough that a barge-in is caught well inside 300 ms. */
const SAMPLE_MS = 30

/**
 * Feeds `detector` from the live sources until the returned function is called. A timer, not
 * animation frames: those stop in a hidden tab, and the turn in progress must still be closed.
 */
export function watchTurns(detector: TurnDetector, sources: TurnSources): () => void {
  const timer = setInterval(() => {
    const event = detector.step({
      now: performance.now(),
      level: sources.level(),
      agentLevel: sources.agentLevel(),
      agentSpeaking: sources.agentSpeaking(),
      busy: sources.busy(),
    })
    if (event) sources.onEvent(event)
  }, SAMPLE_MS)
  return () => clearInterval(timer)
}

/** Whether hands-free can run here: it needs the same audio stack as capture, plus a level meter. */
export function isTurnDetectionSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof AnalyserNode !== 'undefined'
  )
}
