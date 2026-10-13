import {
  AUDIO_TTS_SAMPLE_RATE,
  TTS_OPUS_LENGTH_BYTES,
  TTS_OPUS_PACKET_MS,
} from '@ryadom/contracts/api/dialogs'
import type { PcmSink, StreamDecoder } from './tts-decoder'

/**
 * Opus for the agent's speech: which decoder this device has, and the decoders themselves.
 *
 * WebCodecs (`AudioDecoder`) is the platform's own and costs nothing to load: Chrome and Android
 * WebView 94+, Firefox 130+ on the desktop, Safari and iOS 26+. Where it is missing (iOS 15 to 18,
 * Firefox on Android) the WASM build of libopus (`opus-decoder`, about 60 KB gzipped) stands in; it is
 * loaded only on such a device, only when a dialog opens, and only if the page may compile WebAssembly
 * (the CSP needs 'wasm-unsafe-eval'). A device with neither is not offered Opus at all: the client
 * names only what it can decode in `hello`.
 */

export type OpusBackend = 'webcodecs' | 'wasm'

type OpusDecoderModule = typeof import('opus-decoder')

let wasmModule: Promise<OpusDecoderModule> | null = null

/** The WASM decoder, fetched on first need and kept; a failed fetch is forgotten, so the next dialog tries again. */
function loadWasmOpus(): Promise<OpusDecoderModule> {
  wasmModule ??= import('opus-decoder').catch((error: unknown) => {
    wasmModule = null
    throw error
  })
  return wasmModule
}

/** Whether this page may compile WebAssembly: a CSP without 'wasm-unsafe-eval' forbids it, so do some WebViews. */
function canCompileWasm(): boolean {
  try {
    if (typeof WebAssembly !== 'object') return false
    // The smallest valid module: the magic number and the version.
    new WebAssembly.Module(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00))
    return true
  } catch {
    return false
  }
}

async function hasWebCodecsOpus(): Promise<boolean> {
  if (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function') return false
  try {
    const { supported } = await AudioDecoder.isConfigSupported({
      codec: 'opus',
      sampleRate: AUDIO_TTS_SAMPLE_RATE,
      numberOfChannels: 1,
    })
    return supported === true
  } catch {
    return false
  }
}

/** The WASM decoder loads and starts here: only then is it promised to the gateway. */
async function hasWasmOpus(): Promise<boolean> {
  if (!canCompileWasm()) return false
  try {
    const { OpusDecoder } = await loadWasmOpus()
    const decoder = new OpusDecoder({ channels: 1, sampleRate: AUDIO_TTS_SAMPLE_RATE })
    await decoder.ready
    decoder.free()
    return true
  } catch {
    return false
  }
}

let probe: Promise<OpusBackend | null> | null = null
/** What the last probe found: speech that arrives as Opus is decoded with it. */
let known: OpusBackend | null = null

function remember(found: Promise<OpusBackend | null>): Promise<OpusBackend | null> {
  const current: Promise<OpusBackend | null> = found.then((backend) => {
    // A newer probe (after a failure) has the last word.
    if (probe === current) known = backend
    return backend
  })
  probe = current
  return current
}

/** The Opus decoder of this device, null when it has none. Found out once per page. */
export function opusBackend(): Promise<OpusBackend | null> {
  if (probe) return probe
  return remember(
    (async () => {
      if (await hasWebCodecsOpus()) return 'webcodecs'
      if (await hasWasmOpus()) return 'wasm'
      return null
    })(),
  )
}

/** The decoder for speech that arrives as Opus: the one found, or the WASM build if nothing was found yet. */
export function knownOpusBackend(): OpusBackend {
  return known ?? 'wasm'
}

/**
 * A decoder that said yes and then failed on real speech. WebCodecs falls back to the WASM build; a
 * failed WASM build leaves the device without Opus, and the next connection asks for μ-law instead.
 */
function opusFailed(backend: OpusBackend): void {
  known = backend === 'webcodecs' ? 'wasm' : null
  remember(backend === 'webcodecs' ? hasWasmOpus().then((ok) => (ok ? 'wasm' : null)) : Promise.resolve(null))
}

/** For tests: forget what was found out. */
export function resetOpusSupport(): void {
  probe = null
  known = null
  wasmModule = null
}

/** The packets of a frame body: each is a uint16 big-endian length and then its bytes. A cut packet ends the list. */
export function opusPackets(body: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = []
  let at = 0
  while (at + TTS_OPUS_LENGTH_BYTES <= body.length) {
    const length = (body[at]! << 8) | body[at + 1]!
    const start = at + TTS_OPUS_LENGTH_BYTES
    if (length === 0 || start + length > body.length) break
    packets.push(body.subarray(start, start + length))
    at = start + length
  }
  return packets
}

/** One 20 ms output of WebCodecs as mono float samples. */
function samplesOf(data: AudioData): Float32Array {
  const samples = new Float32Array(data.numberOfFrames)
  // Mono float comes in one plane either way; anything else is converted by the platform.
  const native = data.numberOfChannels === 1 && (data.format === 'f32' || data.format === 'f32-planar')
  data.copyTo(samples, native ? { planeIndex: 0 } : { planeIndex: 0, format: 'f32-planar' })
  return samples
}

/**
 * How long WebCodecs may stay silent in the middle of a frame's outputs before what has come out is
 * handed over anyway: a decoder that gave fewer outputs than packets must not hold the speech back.
 */
const BATCH_GAP_MS = 30

/**
 * WebCodecs: decoding runs off the main thread and the outputs come back in order, 20 ms each. The
 * player gets them regrouped to the frames they came in (up to 200 ms): a buffer of its own for every
 * 20 ms would put ten times as many seams in the sound, and a seam between buffers at a rate other than
 * the device's is where the browser's resampler leaves a faint tick (33 to 42 dB under the speech
 * against 40 to 56 dB with 200 ms buffers, measured in Chromium).
 */
class WebCodecsOpus implements StreamDecoder {
  private readonly decoder: AudioDecoder
  /** Microseconds; the decoder wants a timestamp per packet, and the packets follow one another. */
  private timestamp = 0
  private closed = false
  /** Milliseconds of sound each `decode()` call is owed, oldest first: the size of the batches to hand over. */
  private owed: number[] = []
  /** Outputs that came out but wait for the rest of their frame. */
  private batch: Float32Array[] = []
  private batchMs = 0
  private batchRate = AUDIO_TTS_SAMPLE_RATE
  private gapTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly sink: PcmSink,
    private readonly onFail: () => void,
  ) {
    this.decoder = new AudioDecoder({
      output: (data) => {
        try {
          if (!this.closed) this.take(samplesOf(data), data.sampleRate)
        } finally {
          data.close()
        }
      },
      error: () => {
        if (this.closed) return
        this.closed = true
        clearTimeout(this.gapTimer)
        this.onFail()
      },
    })
    this.decoder.configure({ codec: 'opus', sampleRate: AUDIO_TTS_SAMPLE_RATE, numberOfChannels: 1 })
  }

  private take(samples: Float32Array, sampleRate: number): void {
    this.batch.push(samples)
    this.batchRate = sampleRate
    this.batchMs += (samples.length / sampleRate) * 1000
    // Half a millisecond of slack for rates that do not divide 20 ms into whole samples.
    if (this.owed.length > 0 && this.batchMs >= this.owed[0]! - 0.5) {
      this.owed.shift()
      this.release()
    } else {
      clearTimeout(this.gapTimer)
      this.gapTimer = setTimeout(() => {
        // The frame's outputs stopped short: what there is plays, and the frame is no longer owed.
        this.owed.shift()
        this.release()
      }, BATCH_GAP_MS)
    }
  }

  /** Everything that has come out so far goes to the sink as one piece. */
  private release(): void {
    clearTimeout(this.gapTimer)
    const batch = this.batch
    this.batch = []
    this.batchMs = 0
    if (this.closed || batch.length === 0) return
    let samples = batch[0]!
    if (batch.length > 1) {
      samples = new Float32Array(batch.reduce((total, part) => total + part.length, 0))
      let at = 0
      for (const part of batch) {
        samples.set(part, at)
        at += part.length
      }
    }
    this.sink({ samples, sampleRate: this.batchRate })
  }

  decode(body: Uint8Array): void {
    if (this.closed) return
    try {
      const packets = opusPackets(body)
      if (packets.length === 0) return
      this.owed.push(packets.length * TTS_OPUS_PACKET_MS)
      for (const packet of packets) {
        this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.timestamp, data: packet }))
        this.timestamp += TTS_OPUS_PACKET_MS * 1000
      }
    } catch {
      this.closed = true
      clearTimeout(this.gapTimer)
      this.onFail()
    }
  }

  async flush(): Promise<void> {
    if (this.closed || this.decoder.state !== 'configured') return
    await this.decoder.flush().catch(() => {})
    // The speech is over: whatever is left of the last frame plays now.
    this.owed = []
    this.release()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.gapTimer)
    this.batch = []
    if (this.decoder.state !== 'closed') this.decoder.close()
  }
}

/** The slice of the WASM decoder this module uses. */
interface WasmDecoder {
  decodeFrames(packets: Uint8Array[]): {
    channelData: Float32Array[]
    samplesDecoded: number
    sampleRate: number
  }
  free(): void
}

/** The WASM build: synchronous once loaded; what arrives before that waits, in order. */
class WasmOpus implements StreamDecoder {
  private decoder: WasmDecoder | null = null
  private waiting: Uint8Array[] = []
  private closed = false
  private readonly ready: Promise<void>

  constructor(
    private readonly sink: PcmSink,
    onFail: () => void,
  ) {
    this.ready = loadWasmOpus()
      .then(async ({ OpusDecoder }) => {
        const decoder = new OpusDecoder({ channels: 1, sampleRate: AUDIO_TTS_SAMPLE_RATE })
        await decoder.ready
        if (this.closed) return decoder.free()
        this.decoder = decoder
        for (const body of this.waiting) this.run(body)
        this.waiting = []
      })
      .catch(() => {
        this.waiting = []
        if (!this.closed) onFail()
      })
  }

  private run(body: Uint8Array): void {
    const packets = opusPackets(body)
    if (!this.decoder || packets.length === 0) return
    const { channelData, samplesDecoded, sampleRate } = this.decoder.decodeFrames(packets)
    const samples = channelData[0]
    if (samples && samplesDecoded > 0) this.sink({ samples: samples.subarray(0, samplesDecoded), sampleRate })
  }

  decode(body: Uint8Array): void {
    if (this.closed) return
    // The frame's memory belongs to the socket's buffer; a waiting copy must outlive it.
    if (!this.decoder) this.waiting.push(body.slice())
    else this.run(body)
  }

  flush(): Promise<void> {
    return this.ready
  }

  close(): void {
    this.closed = true
    this.waiting = []
    this.decoder?.free()
    this.decoder = null
  }
}

/**
 * The decoder of one speech, on this device's backend. If WebCodecs fails midway, the speech goes on
 * with the WASM build from the next frame (the packets in between are lost: a short gap, not silence).
 */
export function createOpusDecoder(backend: OpusBackend, sink: PcmSink): StreamDecoder {
  const wasm = (): StreamDecoder => new WasmOpus(sink, () => opusFailed('wasm'))
  let current: StreamDecoder
  const fallBack = () => {
    opusFailed('webcodecs')
    current.close()
    current = wasm()
  }
  try {
    current = backend === 'webcodecs' ? new WebCodecsOpus(sink, fallBack) : wasm()
  } catch {
    // The platform said yes to the configuration and then refused it.
    opusFailed('webcodecs')
    current = wasm()
  }
  return {
    decode: (body) => current.decode(body),
    flush: () => current.flush(),
    close: () => current.close(),
  }
}
