import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_USER_SAMPLE_RATE,
  AudioFrameKind,
} from '@ryadom/contracts/api/dialogs'
import { inputConstraint, type AudioDevice } from './devices'
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
  /** The microphone in use: its id (`default` when it is "as in the system") and its name. */
  device(): AudioDevice
  /**
   * Moves to another microphone (null: the one the browser picks) without stopping: the gate, the held
   * frames and the numbering go on as they were. If the new one cannot be opened, the old one stays.
   */
  switchDevice(deviceId: string | null): Promise<void>
  /** Reopens the same microphone with another echo reference (see `EchoCancellation`), if it differs. */
  setEchoCancellation(mode: EchoCancellation): Promise<void>
}

/**
 * What the echo canceller subtracts. `true`: what the browser plays to the system's default speaker,
 * which is all Chrome takes as the reference for sound that does not come over WebRTC. `all`: everything
 * the computer plays (Chrome 141+ on Windows 11 and macOS 14.2+), for when the agent's voice goes to
 * another speaker and would otherwise come back into the microphone as the person's words. Where it is
 * not known it counts as `true`.
 */
export type EchoCancellation = true | 'all'

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
  /** The microphone the person chose (see devices.ts); without it the browser picks one. */
  deviceId?: string | null
  /** `all` while the agent's voice goes to a speaker other than the system's. */
  echoCancellation?: EchoCancellation
  /**
   * The microphone stopped by itself: unplugged, switched off, taken by the system. The capture is
   * silent from then on; the screen moves it elsewhere (`switchDevice`) or lets it go.
   */
  onDeviceLost?: () => void
}

/** One worklet frame is 100 ms (see voice-worklet.js). */
const FRAME_MS = 100

/**
 * Opens a microphone: the chosen one, and if it is gone (unplugged since it was chosen, or its id
 * changed) the one the browser picks, rather than no voice at all.
 */
async function openMicrophone(
  deviceId: string | null | undefined,
  echoCancellation: EchoCancellation,
): Promise<MediaStream> {
  // The DOM types know the flag only as a boolean; a browser without the scope reads `all` as `true`.
  const processing = {
    echoCancellation: echoCancellation as boolean,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  }
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...processing, deviceId: inputConstraint(deviceId) },
      })
    } catch (error) {
      // A refusal is a refusal whatever device was asked for; only a missing device falls back.
      const name = error instanceof Error ? error.name : ''
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw error
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: processing })
}

/**
 * Starts capture and pushes frames to `onFrame`. The browser or the OS asks for permission; a
 * refusal arrives as `MicrophoneDeniedError`, and the screen explains what to do next.
 */
export async function startCapture(
  onFrame: (frame: ArrayBuffer) => void,
  options: StartCaptureOptions = {},
): Promise<VoiceCapture> {
  let echo = options.echoCancellation ?? true
  let stream: MediaStream
  try {
    stream = await openMicrophone(options.deviceId, echo)
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
    let source = audio.createMediaStreamSource(stream)
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

    let stopped = false
    /** A switch is under way: the old microphone ending now (iOS ends it when another opens) is not a loss. */
    let switching = false
    const watchLoss = (watched: MediaStream) => {
      for (const track of watched.getAudioTracks()) {
        // `stop()` from here does not fire `ended`: only the device or the system going away does.
        track.onended = () => {
          if (!stopped && !switching && stream === watched) options.onDeviceLost?.()
        }
      }
    }
    watchLoss(stream)

    /** The microphone `deviceId` (null: the browser's pick) in place of the one in use, with `mode` echo. */
    const reopen = async (deviceId: string | null, mode: EchoCancellation) => {
      if (stopped) return
      switching = true
      let next: MediaStream
      try {
        next = await openMicrophone(deviceId, mode)
      } catch (error) {
        switching = false
        // The old one may have ended while the new one was being opened.
        if (stream.getAudioTracks().every((track) => track.readyState === 'ended')) options.onDeviceLost?.()
        throw error
      }
      switching = false
      if (stopped) {
        for (const track of next.getTracks()) track.stop()
        return
      }
      const previous = stream
      const nextSource = audio.createMediaStreamSource(next)
      source.disconnect()
      nextSource.connect(worklet)
      nextSource.connect(meter)
      source = nextSource
      stream = next
      echo = mode
      watchLoss(next)
      for (const track of previous.getTracks()) track.stop()
    }

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
      device() {
        const track = stream.getAudioTracks()[0]
        return { id: track?.getSettings().deviceId ?? '', label: track?.label ?? '' }
      },
      switchDevice(deviceId) {
        return reopen(deviceId, echo)
      },
      async setEchoCancellation(mode) {
        if (mode === echo) return
        await reopen(stream.getAudioTracks()[0]?.getSettings().deviceId || null, mode)
      },
      async stop() {
        stopped = true
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
