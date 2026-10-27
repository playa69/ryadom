import { canChooseOutput } from './devices'
import { levelOf } from './level'
import type { PcmChunk } from './tts-decoder'

/** Output selection on the context (Chromium); the DOM types do not have it yet. */
type RoutableContext = AudioContext & {
  readonly sinkId: string | object
  setSinkId(sinkId: string): Promise<void>
}

/**
 * Playback of the agent's voice: float samples, already decoded from whatever codec the connection
 * uses (tts-decoder.ts), are queued as `AudioBufferSourceNode`s stitched together on the context
 * clock, so they play without clicks or gaps on every platform, including iPhone, where Media Source
 * Extensions are incomplete.
 *
 * The `AudioContext` is unlocked by the person's first tap (an iOS requirement), so `unlock()` is
 * called from a tap handler rather than on page load.
 *
 * Where the browser allows it (`canChooseOutput`), the voice goes to the speaker the person chose
 * (`setOutput`); otherwise, and until they choose, to the system's.
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
  /** The speaker the person chose, null for the system's. Kept for a context that does not exist yet. */
  private sinkId: string | null = null

  /** Call from a tap handler, otherwise iOS refuses to play audio. */
  async unlock(): Promise<void> {
    let created = false
    if (!this.context) {
      this.context = new AudioContext()
      this.meter = this.context.createAnalyser()
      this.meter.fftSize = 512
      this.meter.connect(this.context.destination)
      this.bins = new Uint8Array(this.meter.fftSize)
      created = true
    }
    // First, while the tap still counts as the person's gesture.
    if (this.context.state === 'suspended') await this.context.resume()
    // Not through the constructor: there a device that is gone fails silently, and nothing is heard.
    if (created && this.sinkId && canChooseOutput()) await this.route(this.context, this.sinkId)
  }

  /**
   * Sends the voice to a speaker (an id from `listAudioDevices`), or to the system's with null. False
   * where the browser cannot choose, or when that speaker is gone: then the system's plays it.
   */
  async setOutput(deviceId: string | null): Promise<boolean> {
    this.sinkId = deviceId
    if (!canChooseOutput()) return deviceId === null
    if (!this.context) return true
    return this.route(this.context, deviceId)
  }

  /** The speaker in use (before the first tap, the one it will be): an id, or '' for the system's. */
  output(): string {
    if (!canChooseOutput()) return ''
    if (!this.context) return this.sinkId ?? ''
    const sink = (this.context as RoutableContext).sinkId
    return typeof sink === 'string' ? sink : ''
  }

  private async route(context: AudioContext, deviceId: string | null): Promise<boolean> {
    const routable = context as RoutableContext
    try {
      await routable.setSinkId(deviceId ?? '')
      return true
    } catch {
      // Unplugged since it was chosen: the system's speaker is better than silence.
      await routable.setSinkId('').catch(() => undefined)
      return false
    }
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
