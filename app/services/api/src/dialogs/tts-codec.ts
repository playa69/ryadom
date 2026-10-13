import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_TTS_SAMPLE_RATE,
  AudioFrameKind,
  type TtsCodec,
} from '@ryadom/contracts/api/dialogs'
import { opusPool, type OpusPool, type OpusStream } from './opus-pool'

/**
 * The agent's speech on its way to the client: the agent always sends PCM16 at 24 kHz, the client gets
 * it in the codec picked for its connection (`TtsCodec` in the contract describes the three).
 *
 * pcm16 passes through untouched, μ-law is a table lookup per sample, and Opus goes to a worker thread
 * (opus-pool.ts). Whatever the codec, a frame keeps its number and its 200 ms.
 */

/**
 * The codec of a connection: the first one in the client's `hello.codecs` that this server offers
 * (`DIALOG_AUDIO_CODECS`). A client that sent no list, an old build among them, gets pcm16.
 */
export function pickTtsCodec(offered: unknown, enabled: readonly TtsCodec[]): TtsCodec {
  if (!Array.isArray(offered)) return 'pcm16'
  for (const name of offered) {
    if (typeof name === 'string' && (enabled as readonly string[]).includes(name)) return name as TtsCodec
  }
  return 'pcm16'
}

// ─── μ-law ────────────────────────────────────────────────────────────────────

const MULAW_BIAS = 0x84
const MULAW_CLIP = 32_635

/** G.711 μ-law of one PCM16 sample. */
export function linearToMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0
  const magnitude = Math.min(Math.abs(sample), MULAW_CLIP) + MULAW_BIAS
  // The segment is the highest set bit above bit 7; the four bits under it are the mantissa.
  let exponent = 7
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

/** Every PCM16 value (as an unsigned 16-bit index) to its μ-law byte: 64 KiB, built once. */
const MULAW_OF = (() => {
  const table = new Uint8Array(65_536)
  for (let index = 0; index < 65_536; index++)
    table[index] = linearToMulaw(index < 32_768 ? index : index - 65_536)
  return table
})()

/** PCM16 little-endian bytes to μ-law, one byte per sample. */
export function encodeMulaw(pcm: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length >> 1)
  for (let i = 0, o = 0; o < out.length; i += 2, o++) out[o] = MULAW_OF[pcm[i]! | (pcm[i + 1]! << 8)]!
  return out
}

// ─── Encoders ─────────────────────────────────────────────────────────────────

/** One speech of the agent (`tts_start` to `tts_end`), re-encoded for the client. */
export interface SpeechEncoder {
  /** A binary frame of the agent: the frame for the client, null when nothing goes out for it. */
  frame(frame: Buffer): Buffer | null | Promise<Buffer | null>
  /** The speech is over: a last frame with what was held back, if anything was. */
  finish(): Promise<Buffer | null> | null
  /** Drops the speech: the connection is gone. */
  close(): void
}

export interface OpusSpeechSettings {
  bitrate: number
  complexity: number
}

/** A frame of the agent that is speech: anything else passes through as it came. */
function isSpeech(frame: Buffer): boolean {
  return frame.length > AUDIO_FRAME_HEADER_BYTES && frame.readUInt8(0) === AudioFrameKind.Tts
}

const passThrough: SpeechEncoder = {
  frame: (frame) => frame,
  finish: () => null,
  close: () => {},
}

const mulaw: SpeechEncoder = {
  frame: (frame) =>
    isSpeech(frame)
      ? Buffer.concat([
          frame.subarray(0, AUDIO_FRAME_HEADER_BYTES),
          encodeMulaw(frame.subarray(AUDIO_FRAME_HEADER_BYTES)),
        ])
      : frame,
  finish: () => null,
  close: () => {},
}

class OpusSpeech implements SpeechEncoder {
  private readonly stream: OpusStream
  private lastSequence = -1

  constructor(pool: OpusPool, settings: OpusSpeechSettings) {
    this.stream = pool.open({ sampleRate: AUDIO_TTS_SAMPLE_RATE, ...settings })
  }

  frame(frame: Buffer): Buffer | Promise<Buffer | null> {
    if (!isSpeech(frame)) return frame
    const header = Buffer.from(frame.subarray(0, AUDIO_FRAME_HEADER_BYTES))
    this.lastSequence = header.readUInt32BE(1)
    return this.stream
      .encode(frame.subarray(AUDIO_FRAME_HEADER_BYTES))
      .then((body) => (body ? Buffer.concat([header, body]) : null))
  }

  finish(): Promise<Buffer | null> | null {
    if (this.lastSequence < 0) {
      this.stream.close()
      return null
    }
    // The tail goes out as one more frame, numbered after the last one.
    const header = Buffer.alloc(AUDIO_FRAME_HEADER_BYTES)
    header.writeUInt8(AudioFrameKind.Tts, 0)
    header.writeUInt32BE((this.lastSequence + 1) >>> 0, 1)
    return this.stream.finish().then((body) => (body ? Buffer.concat([header, body]) : null))
  }

  close(): void {
    this.stream.close()
  }
}

/** The encoder of one speech in `codec`. Opus speeches share the process's worker pool. */
export function createSpeechEncoder(
  codec: TtsCodec,
  opus: OpusSpeechSettings,
  pool: () => OpusPool = opusPool,
): SpeechEncoder {
  switch (codec) {
    case 'pcm16':
      return passThrough
    case 'mulaw':
      return mulaw
    case 'opus':
      return new OpusSpeech(pool(), opus)
  }
}
