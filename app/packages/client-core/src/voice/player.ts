import { levelOf } from './level'
import type { PcmChunk } from './tts-decoder'

/**
 * Playback of the agent's voice: float samples, already decoded from whatever codec the connection
 * uses (tts-decoder.ts), are queued as `AudioBufferSourceNode`s stitched together on the context
 * clock, so they play without clicks or gaps on every platform, including iPhone, where Media Source
 * Extensions are incomplete.
 *
 * The `AudioContext` is unlocked by the person's first tap (an iOS requirement), so `unlock()` is
 * called from a tap handler rather than on page load.
 */
export class VoicePlayer {
  private context: AudioContext | null = null
  /** Time on the AudioContext clock where the queue currently ends. */
  private playHead = 0
  private sources = new Set<AudioBufferSourceNode>()
  /** Every source plays through it, so the screen can read how loud the agent is right now. */
  private meter: AnalyserNode | null = null
  private bins = new Uint8Array(0)
  private drainWaiters: Array<() => void> = []
  /**
   * After an interruption the frames already in flight belong to speech nobody wants. They carry no
   * message id, so everything is dropped until the next `begin`.
   */
  private muted = false

  /** Call from a tap handler, otherwise iOS refuses to play audio. */
  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext()
      this.meter = this.context.createAnalyser()
      this.meter.fftSize = 512
      this.meter.connect(this.context.destination)
      this.bins = new Uint8Array(this.meter.fftSize)
    }
    if (this.context.state === 'suspended') await this.context.resume()
  }

  /** Whether the agent's voice is audible or still queued. */
  get speaking(): boolean {
    return this.sources.size > 0
  }

  /** Resolves when nothing is playing or queued any more: whoever speaks next does not talk over the agent. */
  drained(): Promise<void> {
    if (this.sources.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  private releaseDrained(): void {
    if (this.sources.size > 0) return
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** How loud the agent is right now, 0..1. Cheap enough to read on every animation frame. */
  level(): number {
    if (!this.meter || this.sources.size === 0) return 0
    this.meter.getByteTimeDomainData(this.bins)
    return levelOf(this.bins)
  }

  /** The agent starts speaking a message (`tts_start`): its frames play again. */
  begin(): void {
    this.muted = false
  }

  /** Decoded speech from the socket, played right after what is already queued. */
  enqueue(chunk: PcmChunk): void {
    if (!this.context || this.muted || chunk.samples.length === 0) return

    const buffer = this.context.createBuffer(1, chunk.samples.length, chunk.sampleRate)
    buffer.getChannelData(0).set(chunk.samples)

    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.meter ?? this.context.destination)
    // A small lead time, otherwise the first frame is scheduled in the past and is lost.
    const startAt = Math.max(this.context.currentTime + 0.05, this.playHead)
    source.start(startAt)
    this.playHead = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      this.releaseDrained()
    }
  }

  /** The person interrupted: drop everything that has not played yet. */
  stop(): void {
    this.muted = true
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // The source has already finished, which is not an error.
      }
    }
    this.sources.clear()
    this.playHead = this.context?.currentTime ?? 0
    this.releaseDrained()
  }

  async dispose(): Promise<void> {
    this.stop()
    await this.context?.close()
    this.context = null
    this.meter = null
  }
}
