import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_FRAME_HEADER_BYTES, AudioFrameKind } from '@ryadom/contracts/api/dialogs'
import { opusBackend, opusPackets, resetOpusSupport } from '../src/voice/opus'
import {
  MULAW_TABLE,
  TtsReceiver,
  createStreamDecoder,
  decodeMulaw,
  decodePcm16,
  supportedTtsCodecs,
  type PcmChunk,
  type PcmSink,
  type StreamDecoder,
} from '../src/voice/tts-decoder'
import { OPUS_FRAME_BODIES } from './fixtures/opus-speech'

const RATE = 24_000

/** The voice the Opus fixture was made from: a 140 Hz tone with harmonics, swelling like syllables. */
function voice(samples: number, offset = 0): Int16Array {
  const out = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    const t = (offset + i) / RATE
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)
    let value = 0
    for (let harmonic = 1; harmonic <= 6; harmonic++)
      value += Math.sin(2 * Math.PI * 140 * harmonic * t) / harmonic
    out[i] = Math.round(9000 * syllable * value)
  }
  return out
}

/** A `0x02` frame around a body. */
function frame(body: Uint8Array, sequence = 0, kind = AudioFrameKind.Tts): ArrayBuffer {
  const bytes = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + body.length)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, kind)
  view.setUint32(1, sequence)
  bytes.set(body, AUDIO_FRAME_HEADER_BYTES)
  return bytes.buffer
}

const base64 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'base64'))

const rms = (samples: ArrayLike<number>): number => {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! ** 2
  return Math.sqrt(sum / Math.max(1, samples.length))
}

const concat = (chunks: PcmChunk[]): Float32Array => {
  const out = new Float32Array(chunks.reduce((total, chunk) => total + chunk.samples.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk.samples, at)
    at += chunk.samples.length
  }
  return out
}

beforeEach(() => resetOpusSupport())
afterEach(() => {
  vi.unstubAllGlobals()
  resetOpusSupport()
})

describe('PCM16 и μ-law', () => {
  it('PCM16 читается и с нечётного смещения, где стоят сэмплы после 5-байтового заголовка', () => {
    const buffer = frame(new Uint8Array([0x00, 0x00, 0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]))
    expect([...decodePcm16(new Uint8Array(buffer, AUDIO_FRAME_HEADER_BYTES))]).toEqual([
      0,
      0.5,
      -0.5,
      32767 / 0x8000,
    ])
  })

  it('таблица μ-law: опорные значения G.711, симметрия знака, монотонность', () => {
    expect(MULAW_TABLE).toHaveLength(256)
    expect(MULAW_TABLE[0xff]).toBe(0)
    expect(MULAW_TABLE[0x80]).toBe(32124 / 0x8000)
    expect(MULAW_TABLE[0x00]).toBe(-32124 / 0x8000)
    for (let byte = 0; byte < 128; byte++) {
      expect(MULAW_TABLE[byte]).toBe(-MULAW_TABLE[byte | 0x80]!)
      // Within a sign, a smaller byte is a louder sample.
      if (byte > 0) expect(MULAW_TABLE[byte | 0x80]!).toBeLessThan(MULAW_TABLE[(byte - 1) | 0x80]!)
    }
  })

  it('кадр μ-law: по сэмплу на байт', () => {
    expect([...decodeMulaw(Uint8Array.of(0xff, 0x80, 0x00))]).toEqual([0, 32124 / 0x8000, -32124 / 0x8000])
  })
})

describe('пакеты Opus в кадре', () => {
  it('длина впереди каждого пакета; обрезанный или пустой пакет заканчивает список', () => {
    const body = Uint8Array.of(0, 2, 7, 8, 0, 1, 9, 0, 5, 1)
    expect(opusPackets(body).map((packet) => [...packet])).toEqual([[7, 8], [9]])
    expect(opusPackets(Uint8Array.of(0, 0, 1))).toEqual([])
  })

  it('кадр шлюза — десять пакетов', () => {
    expect(opusPackets(base64(OPUS_FRAME_BODIES[0]!))).toHaveLength(10)
  })
})

describe('TtsReceiver', () => {
  /** A decoder that answers when told to: like Opus through WebCodecs, a few milliseconds later. */
  function lateDecoders() {
    const pending: Array<() => void> = []
    const factory = (codec: string, sink: PcmSink): StreamDecoder => {
      if (codec !== 'late') return createStreamDecoder(codec, sink)
      let flushed: (() => void) | null = null
      let waiting = 0
      return {
        decode: (body) => {
          waiting += 1
          pending.push(() => {
            sink({ samples: decodePcm16(body), sampleRate: RATE })
            waiting -= 1
            if (waiting === 0) flushed?.()
          })
        },
        flush: () =>
          waiting === 0 ? Promise.resolve() : new Promise<void>((resolve) => (flushed = resolve)),
        close: () => {},
      }
    }
    const release = () => {
      for (const answer of pending.splice(0)) answer()
    }
    return { factory, release }
  }

  const pcm = (...samples: number[]) => new Uint8Array(Int16Array.from(samples).buffer)
  const values = (chunks: PcmChunk[]) => [...concat(chunks)].map((sample) => Math.round(sample * 0x8000))

  it('речь, начатая, пока предыдущая ещё декодируется, ждёт её: порядок кадров сохраняется', async () => {
    const out: PcmChunk[] = []
    const { factory, release } = lateDecoders()
    const receiver = new TtsReceiver((chunk) => out.push(chunk), factory)

    receiver.begin('late')
    receiver.push(frame(pcm(1, 2)))
    receiver.push(frame(pcm(3)))
    receiver.end()
    receiver.begin('pcm16')
    receiver.push(frame(pcm(4, 5)))
    expect(out).toEqual([])

    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(values(out)).toEqual([1, 2, 3, 4, 5])

    // The first speech is out of the way: the next one plays at once.
    receiver.push(frame(pcm(6)))
    expect(values(out)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('перебивание: недекодированное выбрасывается, летящие кадры не играют до следующего tts_start', async () => {
    const out: PcmChunk[] = []
    const { factory, release } = lateDecoders()
    const receiver = new TtsReceiver((chunk) => out.push(chunk), factory)

    receiver.begin('late')
    receiver.push(frame(pcm(1)))
    receiver.cancel()
    release()
    receiver.push(frame(pcm(2)))
    await Promise.resolve()
    expect(out).toEqual([])

    receiver.begin('pcm16')
    receiver.push(frame(pcm(3)))
    expect(values(out)).toEqual([3])
  })

  it('чужие виды кадров, кадры без звука и незнакомый кодек не играют', () => {
    const out: PcmChunk[] = []
    const receiver = new TtsReceiver((chunk) => out.push(chunk))
    receiver.push(frame(pcm(1), 0, AudioFrameKind.User))
    receiver.push(new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES))
    expect(out).toEqual([])

    // A codec from the future would be noise read as PCM: silence instead.
    receiver.begin('aac')
    receiver.push(frame(pcm(1, 2, 3)))
    expect(out).toEqual([])
  })

  it('кадры без tts_start — кодек соединения, PCM16 по умолчанию', async () => {
    const out: PcmChunk[] = []
    const receiver = new TtsReceiver((chunk) => out.push(chunk))
    receiver.push(frame(pcm(7)))
    expect(values(out)).toEqual([7])

    receiver.begin('mulaw')
    receiver.end()
    receiver.push(frame(Uint8Array.of(0xff)))
    // It waits behind the speeches before it, which leave a tick later.
    await vi.waitFor(() => expect(values(out)).toEqual([7, 0]))
  })
})

describe('Opus на WASM (iOS до 26, Firefox на Android)', () => {
  it('кадры шлюза декодируются обратно в ту же речь: 20 пакетов по 480 сэмплов, громкость та же', async () => {
    const out: PcmChunk[] = []
    const decoder = createStreamDecoder('opus', (chunk) => out.push(chunk))
    for (const body of OPUS_FRAME_BODIES) decoder.decode(base64(body))
    await decoder.flush()
    decoder.close()

    expect(out.every((chunk) => chunk.sampleRate === RATE)).toBe(true)
    const decoded = concat(out)
    expect(decoded.length).toBe(20 * 480)
    const original = Float32Array.from(voice(9600), (sample) => sample / 0x8000)
    const ratio = rms(decoded.subarray(2400)) / rms(original.subarray(2400))
    expect(ratio).toBeGreaterThan(0.7)
    expect(ratio).toBeLessThan(1.3)
  })

  it('без WebCodecs устройство объявляет Opus, если WASM загрузился', async () => {
    expect(await opusBackend()).toBe('wasm')
    expect(await supportedTtsCodecs()).toEqual(['opus', 'mulaw', 'pcm16'])
  })

  it('CSP запрещает WebAssembly и WebCodecs нет: Opus не объявляется, остаётся μ-law', async () => {
    vi.stubGlobal('WebAssembly', {
      ...WebAssembly,
      Module: class {
        constructor() {
          throw new Error("Refused to compile: 'wasm-unsafe-eval' is not allowed")
        }
      },
    })
    expect(await supportedTtsCodecs()).toEqual(['mulaw', 'pcm16'])
  })
})

describe('Opus через WebCodecs', () => {
  /**
   * A stand-in for the platform decoder: answers every packet with 20 ms at 48 kHz, a moment later.
   * `silentAfter`: packets from this number on (counting all the packets given) get no answer at all.
   */
  function stubWebCodecs(
    options: { supported?: boolean; failOnDecode?: boolean; silentAfter?: number } = {},
  ) {
    const decoded: number[] = []
    class FakeAudioDecoder {
      static isConfigSupported = vi.fn(async () => ({ supported: options.supported ?? true }))
      state = 'unconfigured'
      private pending = 0
      private flushed: (() => void) | null = null
      constructor(private readonly init: { output(data: unknown): void; error(error: Error): void }) {}
      configure() {
        this.state = 'configured'
      }
      decode(chunk: { timestamp: number }) {
        if (options.failOnDecode) {
          this.state = 'closed'
          queueMicrotask(() => this.init.error(new Error('decode failed')))
          return
        }
        decoded.push(chunk.timestamp)
        if (decoded.length > (options.silentAfter ?? Infinity)) return
        this.pending += 1
        queueMicrotask(() => {
          this.init.output({
            numberOfFrames: 960,
            numberOfChannels: 1,
            format: 'f32-planar',
            sampleRate: 48_000,
            copyTo: (target: Float32Array) => target.fill(0.25),
            close: () => {},
          })
          this.pending -= 1
          if (this.pending === 0) this.flushed?.()
        })
      }
      flush() {
        return this.pending === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => (this.flushed = resolve))
      }
      close() {
        this.state = 'closed'
      }
    }
    class FakeChunk {
      timestamp: number
      constructor(init: { timestamp: number }) {
        this.timestamp = init.timestamp
      }
    }
    vi.stubGlobal('AudioDecoder', FakeAudioDecoder)
    vi.stubGlobal('EncodedAudioChunk', FakeChunk)
    return { decoded, FakeAudioDecoder }
  }

  it('WebCodecs есть — он и декодирует: пакет за пакетом, по порядку, на своей частоте', async () => {
    const { decoded, FakeAudioDecoder } = stubWebCodecs()
    expect(await opusBackend()).toBe('webcodecs')
    expect(FakeAudioDecoder.isConfigSupported).toHaveBeenCalledWith({
      codec: 'opus',
      sampleRate: 24_000,
      numberOfChannels: 1,
    })

    const out: PcmChunk[] = []
    const receiver = new TtsReceiver((chunk) => out.push(chunk))
    receiver.begin('opus')
    for (const body of OPUS_FRAME_BODIES) receiver.push(frame(base64(body)))
    receiver.end()
    await vi.waitFor(() => expect(concat(out).length).toBe(20 * 960))

    // Timestamps run 20 ms apart, in microseconds.
    expect(decoded.slice(0, 3)).toEqual([0, 20_000, 40_000])
    expect(out.every((chunk) => chunk.sampleRate === 48_000)).toBe(true)
  })

  it('20-мс выходы WebCodecs уходят плееру кадрами по 200 мс: десять буферов вместо одного — десять лишних швов', async () => {
    stubWebCodecs()
    await opusBackend()

    const out: PcmChunk[] = []
    const receiver = new TtsReceiver((chunk) => out.push(chunk))
    receiver.begin('opus')
    for (const body of OPUS_FRAME_BODIES) receiver.push(frame(base64(body)))
    receiver.end()
    await vi.waitFor(() => expect(out).toHaveLength(2))

    expect(out.map((chunk) => chunk.samples.length)).toEqual([9600, 9600])
    // Order inside a piece is the order of the packets (the fake plays 0.25 everywhere, so only the size shows).
    expect(out.every((chunk) => chunk.samples.every((sample) => sample === 0.25))).toBe(true)
  })

  it('кадр, у которого вышло меньше пакетов, чем вошло, не застревает: через паузу играет то, что есть', async () => {
    stubWebCodecs({ silentAfter: 7 })
    await opusBackend()

    const out: PcmChunk[] = []
    const receiver = new TtsReceiver((chunk) => out.push(chunk))
    receiver.begin('opus')
    receiver.push(frame(base64(OPUS_FRAME_BODIES[0]!)))

    // No `tts_end` yet and three of the ten packets never came out: seven of them play after the pause.
    await vi.waitFor(() => expect(concat(out).length).toBe(7 * 960))
    expect(out).toHaveLength(1)
  })

  it('конец речи отдаёт остаток последнего кадра сразу, не дожидаясь паузы', async () => {
    stubWebCodecs({ silentAfter: 7 })
    await opusBackend()

    const out: PcmChunk[] = []
    const receiver = new TtsReceiver((chunk) => out.push(chunk))
    receiver.begin('opus')
    receiver.push(frame(base64(OPUS_FRAME_BODIES[0]!)))
    receiver.end()
    await Promise.resolve()
    await Promise.resolve()
    await vi.waitFor(() => expect(concat(out).length).toBe(7 * 960), { timeout: 20, interval: 1 })
  })

  it('WebCodecs сказал «да», а на речи упал: речь продолжается на WASM, следующее соединение — без WebCodecs', async () => {
    stubWebCodecs({ failOnDecode: true })
    expect(await opusBackend()).toBe('webcodecs')

    const out: PcmChunk[] = []
    const receiver = new TtsReceiver((chunk) => out.push(chunk))
    receiver.begin('opus')
    receiver.push(frame(base64(OPUS_FRAME_BODIES[0]!)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    receiver.push(frame(base64(OPUS_FRAME_BODIES[1]!)))
    receiver.end()

    // The first frame is lost with the failed decoder; the second plays through the WASM build.
    await vi.waitFor(() => expect(concat(out).length).toBe(10 * 480))
    expect(out[0]!.sampleRate).toBe(24_000)
    expect(await opusBackend()).toBe('wasm')
  })

  it('WebCodecs без Opus — WASM', async () => {
    stubWebCodecs({ supported: false })
    expect(await opusBackend()).toBe('wasm')
  })

  it('долгая проверка не держит hello: это соединение идёт без Opus', async () => {
    vi.stubGlobal(
      'AudioDecoder',
      class {
        static isConfigSupported = () => new Promise(() => {})
      },
    )
    vi.stubGlobal('EncodedAudioChunk', class {})
    expect(await supportedTtsCodecs(10)).toEqual(['mulaw', 'pcm16'])
  })
})
