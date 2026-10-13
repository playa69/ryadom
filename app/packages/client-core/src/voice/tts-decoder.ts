import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_TTS_SAMPLE_RATE,
  AudioFrameKind,
  type TtsCodec,
} from '@ryadom/contracts/api/dialogs'
import { createOpusDecoder, knownOpusBackend, opusBackend } from './opus'

/**
 * The agent's speech from the socket to the player: `0x02` frames in the codec the gateway picked for
 * the connection (`TtsCodec` in the contract) become float samples, in the order the frames came.
 *
 * One decoder per speech, from `tts_start` to `tts_end`: Opus packets depend on the ones before them,
 * so a new speech starts a fresh decoder, and an interruption throws the current one away.
 */

/** Mono float samples for the player. Opus through WebCodecs may come back at 48 kHz; the rate travels along. */
export interface PcmChunk {
  samples: Float32Array
  sampleRate: number
}

export type PcmSink = (chunk: PcmChunk) => void

/** The decoder of one speech. */
export interface StreamDecoder {
  /** The body of one frame (the header already cut off); what it decodes goes to the sink, in order. */
  decode(body: Uint8Array): void
  /** No more frames: resolves once everything given has come out. */
  flush(): Promise<void>
  /** Stop now: nothing more comes out. */
  close(): void
}

/** How long `hello` may wait for the device to find out whether it decodes Opus (the WASM build loads over the network). */
const OPUS_PROBE_WAIT_MS = 1500

/**
 * What to put in `hello.codecs`, most wanted first: Opus where the device can decode it, else μ-law,
 * which every device decodes and which is half the size of PCM16. If finding out about Opus takes too
 * long, this connection goes without it and a later one gets it.
 */
export async function supportedTtsCodecs(waitMs = OPUS_PROBE_WAIT_MS): Promise<TtsCodec[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs)
  })
  const backend = await Promise.race([opusBackend().catch(() => null), late])
  clearTimeout(timer)
  return backend ? ['opus', 'mulaw', 'pcm16'] : ['mulaw', 'pcm16']
}

// ─── PCM16 and μ-law ──────────────────────────────────────────────────────────

/** Little-endian PCM16 to floats. The body starts at an odd offset of its frame, so a DataView reads it. */
export function decodePcm16(body: Uint8Array): Float32Array {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const samples = new Float32Array(body.byteLength >> 1)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000
  return samples
}

/** Every μ-law byte to its float sample (G.711): 256 values, built once. */
export const MULAW_TABLE = (() => {
  const table = new Float32Array(256)
  for (let byte = 0; byte < 256; byte++) {
    const u = ~byte & 0xff
    const exponent = (u >> 4) & 0x07
    const magnitude = ((((u & 0x0f) << 3) + 0x84) << exponent) - 0x84
    table[byte] = (u & 0x80 ? -magnitude : magnitude) / 0x8000
  }
  return table
})()

export function decodeMulaw(body: Uint8Array): Float32Array {
  const samples = new Float32Array(body.length)
  for (let i = 0; i < body.length; i++) samples[i] = MULAW_TABLE[body[i]!]!
  return samples
}

/** PCM16 and μ-law: every frame decodes on the spot. */
function sampleDecoder(decode: (body: Uint8Array) => Float32Array, sink: PcmSink): StreamDecoder {
  return {
    decode: (body) => {
      const samples = decode(body)
      if (samples.length > 0) sink({ samples, sampleRate: AUDIO_TTS_SAMPLE_RATE })
    },
    flush: () => Promise.resolve(),
    close: () => {},
  }
}

/** A codec this client does not know: its frames would be noise played as PCM, so they are dropped. */
const silence: StreamDecoder = { decode: () => {}, flush: () => Promise.resolve(), close: () => {} }

// ─── Receiver ─────────────────────────────────────────────────────────────────

interface Speech {
  decoder: StreamDecoder
  /** Output that is ready but must wait: a speech before this one is still coming out. */
  held: PcmChunk[]
  /** `tts_end` came: no more frames for this speech. */
  ended: boolean
  /** Everything it decoded has come out. */
  drained: boolean
}

export type DecoderFactory = (codec: TtsCodec | string, sink: PcmSink) => StreamDecoder

export function createStreamDecoder(codec: TtsCodec | string, sink: PcmSink): StreamDecoder {
  switch (codec) {
    case 'pcm16':
      return sampleDecoder(decodePcm16, sink)
    case 'mulaw':
      return sampleDecoder(decodeMulaw, sink)
    case 'opus':
      return createOpusDecoder(knownOpusBackend(), sink)
    default:
      return silence
  }
}

/**
 * Turns the speech frames of one connection into samples, speech by speech. The output keeps the
 * frames' order across speeches too: a speech that begins while the one before it is still being
 * decoded (Opus through WebCodecs answers a few milliseconds later) waits for it to come out first.
 */
export class TtsReceiver {
  /** The speeches whose output is not all out yet; the first one plays, the rest wait their turn. */
  private speeches: Speech[] = []
  /** After an interruption, frames still on their way belong to speech nobody wants: dropped until `begin`. */
  private discarding = false
  /** The codec of the connection, as the last `tts_start` named it. */
  private codec: TtsCodec | string = 'pcm16'

  constructor(
    private readonly sink: PcmSink,
    private readonly decoderFor: DecoderFactory = createStreamDecoder,
  ) {}

  /** `tts_start`: a new speech with a decoder of its own. A speech that never got its `tts_end` ends here. */
  begin(codec: TtsCodec | string = 'pcm16'): void {
    this.end()
    this.discarding = false
    this.codec = codec
    this.open(codec)
  }

  /** A binary frame from the socket. Other kinds than speech are ignored: the protocol may add more. */
  push(frame: ArrayBuffer): void {
    if (this.discarding || frame.byteLength <= AUDIO_FRAME_HEADER_BYTES) return
    if (new DataView(frame).getUint8(0) !== AudioFrameKind.Tts) return
    // Speech without `tts_start` (a gateway never sends it, the protocol does not forbid it): the
    // connection's codec, PCM16 until a `tts_start` names another.
    const speech = this.current() ?? this.open(this.codec)
    speech.decoder.decode(new Uint8Array(frame, AUDIO_FRAME_HEADER_BYTES))
  }

  /** `tts_end`: what is still being decoded comes out, then the decoder goes. */
  end(): void {
    const speech = this.current()
    if (!speech) return
    speech.ended = true
    void speech.decoder.flush().then(() => {
      speech.drained = true
      speech.decoder.close()
      this.advance()
    })
  }

  /** The person interrupted, or the connection dropped: every decoder goes, nothing more comes out. */
  cancel(): void {
    for (const speech of this.speeches) speech.decoder.close()
    this.speeches = []
    this.discarding = true
  }

  private current(): Speech | undefined {
    const last = this.speeches.at(-1)
    return last && !last.ended ? last : undefined
  }

  private open(codec: TtsCodec | string): Speech {
    const speech: Speech = { decoder: silence, held: [], ended: false, drained: false }
    speech.decoder = this.decoderFor(codec, (chunk) => {
      if (!this.speeches.includes(speech)) return
      if (this.speeches[0] === speech) this.sink(chunk)
      else speech.held.push(chunk)
    })
    this.speeches.push(speech)
    return speech
  }

  /** The first speech is all out: the next one plays what it held, and so on. */
  private advance(): void {
    while (this.speeches[0]?.drained) {
      this.speeches.shift()
      const next = this.speeches[0]
      if (!next) return
      for (const chunk of next.held) this.sink(chunk)
      next.held = []
    }
  }
}
