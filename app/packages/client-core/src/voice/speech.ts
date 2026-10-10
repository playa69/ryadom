/**
 * The sphere's own voice for the one thing the agent may not speak itself: the greeting (it comes
 * over REST, as text). The agent's own speech always wins; this only fills the silence, so a voice
 * screen is never mute on arrival.
 *
 * Replies are deliberately not here. The agent voices every reply, and its first sound can take a few
 * seconds (a cloud synthesis behind a proxy); a platform voice stepping in after a short wait made the
 * same reply sound twice, first robotic and then in the agent's voice, or both at once. A reply the agent
 * cannot voice arrives as text with an `error VOICE_UNAVAILABLE`, which the screen shows.
 *
 * It uses the platform's speech synthesis, so there is nothing to download and no audio leaves the
 * device. The engine is injected: tests drive a fake one, and a platform without synthesis simply
 * gets a voice that says nothing.
 */

/** The slice of an utterance this module touches. */
export interface SpeechUtterance {
  text: string
  lang: string
  rate: number
  voice: unknown
  onend: ((event?: unknown) => void) | null
  onerror: ((event?: unknown) => void) | null
  onboundary: ((event?: unknown) => void) | null
}

export interface SpeechEngine {
  utterance(text: string): SpeechUtterance
  speak(utterance: SpeechUtterance): void
  cancel(): void
  voices(): ReadonlyArray<{ lang: string }>
}

/** Synthesis built into the browser or WebView, null where there is none. */
export function browserSpeechEngine(): SpeechEngine | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  if (typeof SpeechSynthesisUtterance === 'undefined') return null
  const synth = window.speechSynthesis
  return {
    // The DOM types are stricter about the handlers than the slice this module uses.
    utterance: (text) => new SpeechSynthesisUtterance(text) as unknown as SpeechUtterance,
    speak: (utterance) => synth.speak(utterance as unknown as SpeechSynthesisUtterance),
    cancel: () => synth.cancel(),
    voices: () => synth.getVoices(),
  }
}

let unlocked = false

/**
 * Call from a tap handler. Some platforms (iOS above all) allow speech only after a gesture has
 * started some, so the first tap says nothing, silently, and later speech is let through.
 */
export function unlockSpeech(engine: SpeechEngine | null = browserSpeechEngine()): void {
  if (unlocked || !engine) return
  unlocked = true
  try {
    engine.speak(engine.utterance(''))
  } catch {
    // A platform that refuses is simply a platform without a voice.
  }
}

const LANGUAGE = 'ru-RU'
/** A calm pace: the person came to be heard, not to be hurried. */
const RATE = 0.95
/** Some engines drop a long utterance halfway; sentences stay well short of that. */
const CHUNK_MAX = 220
/** How long the agent has to start its own speech for the greeting before ours does. */
const AGENT_GRACE_MS = 900
/** The id the agent voices the greeting under: the greeting is not a message of the feed. */
export const GREETING_ID = 'greeting'
/** The agent's greeting that never ends must not keep the microphone shut. */
const AGENT_SPEECH_WATCHDOG_MS = 20_000
/** An engine that never reports the end must not hold the conversation: speaking is bounded by the text. */
const WATCHDOG_BASE_MS = 3000
const WATCHDOG_PER_CHAR_MS = 120

/** Sentences, kept whole where they fit; a longer one is cut at a space. */
export function sentencesOf(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?…]+(?:[.!?…]+|$)/g)
  const chunks: string[] = []
  for (const part of parts ?? []) {
    let rest = part.trim()
    while (rest.length > CHUNK_MAX) {
      const cut = rest.lastIndexOf(' ', CHUNK_MAX)
      const at = cut > 0 ? cut : CHUNK_MAX
      chunks.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) chunks.push(rest)
  }
  return chunks
}

export class ReplyVoice {
  /** Messages the agent has promised to speak (it sent `tts_start` for them). */
  private readonly voiced = new Set<string>()
  /** Messages whose speech the agent has finished (it sent `tts_end`). */
  private readonly finished = new Set<string>()
  private readonly startWaiters = new Map<string, Array<(started: boolean) => void>>()
  private readonly endWaiters = new Map<string, Array<() => void>>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private pending = 0
  private spokenId: string | null = null
  private lastWord = 0
  /** Bumped whenever our speech is stopped: whatever was speaking before stops mattering. */
  private epoch = 0
  /** Bumped by `cancel` only: a greeting in progress sees that the person moved on. */
  private cancellations = 0
  private release: (() => void) | null = null

  constructor(
    private readonly engine: SpeechEngine | null = browserSpeechEngine(),
    private readonly graceMs = AGENT_GRACE_MS,
  ) {}

  get supported(): boolean {
    return this.engine !== null
  }

  get speaking(): boolean {
    return this.pending > 0
  }

  /**
   * How loud the voice looks right now, 0..1. Synthesis gives no samples, so the sphere follows the
   * words: each one lights it and it settles before the next.
   */
  level(): number {
    if (!this.speaking) return 0
    const sinceWord = performance.now() - this.lastWord
    return 0.3 + 0.5 * Math.max(0, 1 - sinceWord / 220)
  }

  /** The agent is speaking `messageId` itself: ours, if it already began, gives way. */
  agentSpoke(messageId: string): void {
    this.voiced.add(messageId)
    this.finished.delete(messageId)
    if (this.spokenId === messageId) this.halt()
    for (const resolve of this.startWaiters.get(messageId) ?? []) resolve(true)
    this.startWaiters.delete(messageId)
  }

  /** The agent finished speaking `messageId` (`tts_end`). */
  agentSpeechEnded(messageId: string): void {
    this.finished.add(messageId)
    for (const resolve of this.endWaiters.get(messageId) ?? []) resolve()
    this.endWaiters.delete(messageId)
  }

  agentVoiced(messageId: string): boolean {
    return this.voiced.has(messageId)
  }

  /** True as soon as the agent starts speaking `messageId`, false if it has not within `ms`. */
  agentStarts(messageId: string, ms: number = this.graceMs): Promise<boolean> {
    if (this.voiced.has(messageId)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        const waiters = this.startWaiters.get(messageId)?.filter((waiter) => waiter !== done)
        if (waiters?.length) this.startWaiters.set(messageId, waiters)
        else this.startWaiters.delete(messageId)
        resolve(false)
      }, ms)
      this.timers.add(timer)
      const done = (started: boolean) => {
        clearTimeout(timer)
        this.timers.delete(timer)
        resolve(started)
      }
      this.startWaiters.set(messageId, [...(this.startWaiters.get(messageId) ?? []), done])
    })
  }

  /** Resolves when the agent has finished speaking `messageId`; a speech that never ends is given up on. */
  agentFinishes(messageId: string): Promise<void> {
    if (this.finished.has(messageId)) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, AGENT_SPEECH_WATCHDOG_MS)
      this.timers.add(timer)
      this.endWaiters.set(messageId, [
        ...(this.endWaiters.get(messageId) ?? []),
        () => {
          clearTimeout(timer)
          this.timers.delete(timer)
          resolve()
        },
      ])
    })
  }

  /**
   * The greeting, said aloud, to be followed by listening. It came as text, so the agent may voice it
   * (under `GREETING_ID`) and then its voice is what is played, to the end and until the player has
   * drained; failing that, ours reads it. Returns when the floor is free, or at once if the person
   * moved on (`cancel`) in the meantime.
   */
  async greet(text: string, drained: () => Promise<void> = async () => {}): Promise<void> {
    const mine = this.cancellations
    const agentSpeaks = await this.agentStarts(GREETING_ID)
    if (this.cancellations !== mine) return
    if (!agentSpeaks && this.engine) {
      await this.say(text, GREETING_ID)
      if (this.cancellations !== mine) return
    }
    // The agent may have begun late and silenced ours: then its greeting is what is being said.
    if (this.agentVoiced(GREETING_ID)) {
      await this.agentFinishes(GREETING_ID)
      if (this.cancellations !== mine) return
      await drained()
    }
  }

  /** Speaks `text` and resolves when done, cut off, or given up on. Never rejects. */
  say(text: string, messageId: string | null = null): Promise<void> {
    const engine = this.engine
    const chunks = sentencesOf(text)
    if (!engine || chunks.length === 0) return Promise.resolve()

    this.halt()
    const epoch = this.epoch
    this.spokenId = messageId
    this.pending = chunks.length
    this.lastWord = performance.now()
    const voice = engine.voices().find((candidate) => candidate.lang.toLowerCase().startsWith('ru'))

    return new Promise<void>((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(watchdog)
        if (this.epoch === epoch) {
          this.pending = 0
          this.spokenId = null
          this.release = null
        }
        resolve()
      }
      const watchdog = setTimeout(
        () => {
          if (this.epoch === epoch) engine.cancel()
          finish()
        },
        WATCHDOG_BASE_MS + WATCHDOG_PER_CHAR_MS * text.length,
      )
      this.release = finish

      for (const chunk of chunks) {
        const utterance = engine.utterance(chunk)
        utterance.lang = LANGUAGE
        utterance.rate = RATE
        if (voice) utterance.voice = voice
        utterance.onboundary = () => {
          this.lastWord = performance.now()
        }
        const done = () => {
          if (this.epoch !== epoch) return
          this.pending = Math.max(0, this.pending - 1)
          if (this.pending === 0) finish()
        }
        utterance.onend = done
        utterance.onerror = done
        try {
          engine.speak(utterance)
        } catch {
          done()
        }
      }
    })
  }

  /** Stops our own speech (not what is waited for): the next thing to say, or the agent, takes the floor. */
  private halt(): void {
    this.epoch += 1
    this.pending = 0
    this.spokenId = null
    const release = this.release
    this.release = null
    if (this.engine) {
      try {
        this.engine.cancel()
      } catch {
        // Nothing to stop on a platform that cannot speak.
      }
    }
    release?.()
  }

  /** Silence now: what is being said, what was about to be, and everything that waited for the agent. */
  cancel(): void {
    this.cancellations += 1
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.halt()
    for (const waiters of this.startWaiters.values()) for (const resolve of waiters) resolve(false)
    this.startWaiters.clear()
    for (const waiters of this.endWaiters.values()) for (const resolve of waiters) resolve()
    this.endWaiters.clear()
  }

  dispose(): void {
    this.cancel()
  }
}
