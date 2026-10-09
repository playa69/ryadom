import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_USER_SAMPLE_RATE,
  AudioFrameKind,
} from '@ryadom/contracts/api/dialogs'
import { levelOf } from './level'
import { PRE_ROLL_MS } from './turn-detector'

/**
 * Microphone capture: getUserMedia -> AudioWorklet -> 100 ms PCM16 frames at 16 kHz.
 *
 * Why not MediaRecorder: on Android it produces WebM/Opus and on iOS MP4/AAC, both of which the
 * agent would have to transcode, and fragments without the first chunk do not decode. PCM16 costs
 * 32 KB/s, which is acceptable for v1; Opus through a WASM encoder is v2.
 */

export interface VoiceCapture {
  stop(): Promise<void>
  readonly sampleRate: number
  /** How loud the person is right now, 0..1. Cheap enough to read on every animation frame. */
  level(): number
  /**
   * Hands-free (`gated`): frames start reaching `onFrame`, beginning with the last `PRE_ROLL_MS` that
   * were held back, so the first syllable of the turn is not lost. Without the gate frames always flow.
   */
  open(): void
  /** Hands-free: frames stop reaching `onFrame` (silence is not streamed); the microphone stays on. */
  close(): void
}

export class MicrophoneDeniedError extends Error {
  constructor() {
    super('microphone permission denied')
    this.name = 'MicrophoneDeniedError'
  }
}

/** A socket frame: kind, sequence number, raw samples. */
function frameFor(sequence: number, samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + samples.byteLength)
  const view = new DataView(buffer)
  view.setUint8(0, AudioFrameKind.User)
  view.setUint32(1, sequence, false)
  new Uint8Array(buffer, AUDIO_FRAME_HEADER_BYTES).set(
    new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
  )
  return buffer
}

export interface StartCaptureOptions {
  /**
   * Where the page serves `voice-worklet.js` from. The default is the root of the origin; a client
   * published under a URL prefix (`/web`, `/app`) passes its own, because a root-absolute URL would
   * land on whatever else is served at `/`.
   */
  workletUrl?: string
  /**
   * Hands-free: the microphone is open for the whole session, but frames go out only between `open()`
   * and `close()`. Until then the last `PRE_ROLL_MS` of them are kept in a ring.
   */
  gated?: boolean
}

/** One worklet frame is 100 ms (see voice-worklet.js). */
const FRAME_MS = 100

/**
 * Starts capture and pushes frames to `onFrame`. The browser or the OS asks for permission; a
 * refusal arrives as `MicrophoneDeniedError`, and the screen explains what to do next.
 */
export async function startCapture(
  onFrame: (frame: ArrayBuffer) => void,
  options: StartCaptureOptions = {},
): Promise<VoiceCapture> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
  } catch {
    throw new MicrophoneDeniedError()
  }

  // From here on the microphone is open: whatever fails below must let it go, or the browser's
  // recording indicator stays on with nothing able to turn it off.
  let created: AudioContext | undefined
  try {
    const audio = new AudioContext()
    created = audio
    await audio.audioWorklet.addModule(options.workletUrl ?? '/voice-worklet.js')
    const source = audio.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(audio, 'ryadom-capture', { numberOfOutputs: 0 })

    let sequence = 0
    let flowing = !options.gated
    const held: Int16Array[] = []
    const keep = Math.ceil(PRE_ROLL_MS / FRAME_MS)
    worklet.port.onmessage = (event: MessageEvent<Int16Array>) => {
      if (flowing) {
        onFrame(frameFor(sequence++, event.data))
        return
      }
      held.push(event.data)
      if (held.length > keep) held.shift()
    }
    source.connect(worklet)

    // Only feeds the screen's meter; the frames above do not depend on it.
    const meter = audio.createAnalyser()
    meter.fftSize = 512
    source.connect(meter)
    const bins = new Uint8Array(meter.fftSize)

    return {
      sampleRate: AUDIO_USER_SAMPLE_RATE,
      level() {
        meter.getByteTimeDomainData(bins)
        return levelOf(bins)
      },
      open() {
        if (flowing) return
        flowing = true
        for (const samples of held.splice(0)) onFrame(frameFor(sequence++, samples))
      },
      close() {
        if (!options.gated) return
        flowing = false
        held.length = 0
      },
      async stop() {
        worklet.port.onmessage = null
        source.disconnect()
        worklet.disconnect()
        for (const track of stream.getTracks()) track.stop()
        await audio.close().catch(() => undefined)
      },
    }
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    await created?.close().catch(() => undefined)
    throw error
  }
}

/** Whether capture is possible at all: an old WebView and an http page give no microphone. */
export function isCaptureSupported(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioWorkletNode !== 'undefined'
}
