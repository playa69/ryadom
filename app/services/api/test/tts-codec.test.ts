/**
 * The agent's speech on its way to the client: picking the codec, μ-law, and Opus through the worker
 * pool, decoded back with the same libopus build to be sure the frames hold real speech.
 */
import { afterAll, describe, expect, it } from 'vitest'
import opus from '@evan/opus/wasm/index.js'
import { AUDIO_FRAME_HEADER_BYTES, AudioFrameKind, TTS_CODECS } from '@ryadom/contracts/api/dialogs'
import { DIALOG_AUDIO_CODECS } from '@ryadom/core/config'
import { InOrder } from '../src/dialogs/in-order'
import { OpusPool } from '../src/dialogs/opus-pool'
import { createSpeechEncoder, encodeMulaw, linearToMulaw, pickTtsCodec } from '../src/dialogs/tts-codec'

const RATE = 24_000
/** 200 ms at 24 kHz: one frame of the agent. */
const FRAME_SAMPLES = 4800
const PACKET_SAMPLES = 480

/** Something like a voice: a 140 Hz tone with harmonics, its loudness swelling like syllables. */
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

/** A `0x02` frame of the agent: kind, number, PCM16 little-endian. */
function agentFrame(sequence: number, samples: Int16Array): Buffer {
  const frame = Buffer.alloc(AUDIO_FRAME_HEADER_BYTES + samples.length * 2)
  frame.writeUInt8(AudioFrameKind.Tts, 0)
  frame.writeUInt32BE(sequence, 1)
  for (let i = 0; i < samples.length; i++) frame.writeInt16LE(samples[i]!, AUDIO_FRAME_HEADER_BYTES + i * 2)
  return frame
}

/** The packets of an Opus frame: each is its length (uint16 big-endian) and then its bytes. */
function packetsOf(frame: Buffer): Buffer[] {
  const packets: Buffer[] = []
  let at = AUDIO_FRAME_HEADER_BYTES
  while (at < frame.length) {
    const length = frame.readUInt16BE(at)
    packets.push(frame.subarray(at + 2, at + 2 + length))
    at += 2 + length
  }
  expect(at).toBe(frame.length)
  return packets
}

/** The reference G.711 decoder, written apart from the encoder under test. */
function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff
  const exponent = (u >> 4) & 0x07
  const magnitude = (((u & 0x0f) << 3) + 0x84) << exponent
  return u & 0x80 ? 0x84 - magnitude : magnitude - 0x84
}

const rms = (samples: ArrayLike<number>, from = 0, to = samples.length): number => {
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i]! ** 2
  return Math.sqrt(sum / Math.max(1, to - from))
}

describe('выбор кодека', () => {
  const all = ['opus', 'mulaw', 'pcm16'] as const

  it('имена кодеков в конфиге (core) и в контракте клиента (contracts) — одни и те же', () => {
    // The core does not depend on the contracts, so the list is written twice; this is what keeps the copies equal.
    expect([...DIALOG_AUDIO_CODECS]).toEqual([...TTS_CODECS])
  })

  it('без списка в hello (старые сборки) — pcm16', () => {
    expect(pickTtsCodec(undefined, all)).toBe('pcm16')
    expect(pickTtsCodec('opus', all)).toBe('pcm16')
  })

  it('решает порядок клиента среди того, что сервер включил; незнакомые имена пропускаются', () => {
    expect(pickTtsCodec(['opus', 'mulaw', 'pcm16'], all)).toBe('opus')
    expect(pickTtsCodec(['mulaw', 'opus'], all)).toBe('mulaw')
    expect(pickTtsCodec(['aac', 42, 'mulaw'], all)).toBe('mulaw')
    expect(pickTtsCodec(['opus', 'mulaw'], ['mulaw', 'pcm16'])).toBe('mulaw')
  })

  it('ничего общего — pcm16: его понимает любой клиент', () => {
    expect(pickTtsCodec(['opus'], ['pcm16'])).toBe('pcm16')
    expect(pickTtsCodec([], all)).toBe('pcm16')
  })
})

describe('μ-law', () => {
  it('опорные значения G.711', () => {
    expect(linearToMulaw(0)).toBe(0xff)
    expect(linearToMulaw(-1)).toBe(0x7f)
    expect(linearToMulaw(32_767)).toBe(0x80)
    expect(linearToMulaw(-32_768)).toBe(0x00)
  })

  it('туда и обратно: ошибка в пределах шага сегмента, знак и порядок сохраняются', () => {
    let previous = -Infinity
    for (let sample = -32_768; sample <= 32_767; sample += 7) {
      const restored = mulawToLinear(linearToMulaw(sample))
      const clipped = Math.max(-32_635, Math.min(32_635, sample))
      // The step of a segment is 2^(exponent + 3); rounding down stays within it.
      const exponent = (~linearToMulaw(sample) >> 4) & 0x07
      expect(Math.abs(restored - clipped)).toBeLessThanOrEqual(2 ** (exponent + 3))
      expect(restored).toBeGreaterThanOrEqual(previous)
      previous = restored
    }
  })

  it('кадр: тот же заголовок и номер, по байту на сэмпл', () => {
    const frame = agentFrame(7, voice(FRAME_SAMPLES))
    const encoder = createSpeechEncoder('mulaw', { bitrate: 24_000, complexity: 5 })
    const out = encoder.frame(frame) as Buffer
    expect(out.length).toBe(AUDIO_FRAME_HEADER_BYTES + FRAME_SAMPLES)
    expect(out.subarray(0, AUDIO_FRAME_HEADER_BYTES)).toEqual(frame.subarray(0, AUDIO_FRAME_HEADER_BYTES))
    expect(out.subarray(AUDIO_FRAME_HEADER_BYTES)).toEqual(
      encodeMulaw(frame.subarray(AUDIO_FRAME_HEADER_BYTES)),
    )
    expect(encoder.finish()).toBeNull()
  })

  it('pcm16 проходит как есть', () => {
    const frame = agentFrame(3, voice(FRAME_SAMPLES))
    expect(createSpeechEncoder('pcm16', { bitrate: 24_000, complexity: 5 }).frame(frame)).toBe(frame)
  })
})

describe('Opus', () => {
  const pool = new OpusPool()
  afterAll(() => pool.close())
  const settings = { bitrate: 24_000, complexity: 5 }

  async function encodeSpeech(frames: Int16Array[]): Promise<Buffer[]> {
    const encoder = createSpeechEncoder('opus', settings, () => pool)
    const out = await Promise.all(
      frames.map((samples, sequence) => encoder.frame(agentFrame(sequence, samples))),
    )
    const tail = await encoder.finish()
    return [...out, tail].filter((frame): frame is Buffer => frame !== null)
  }

  function decode(frames: Buffer[]): Int16Array {
    const decoder = new opus.Decoder({ channels: 1, sample_rate: RATE })
    const chunks = frames.flatMap(packetsOf).map((packet) => {
      const pcm = decoder.decode(packet)
      return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)
    })
    decoder.drop()
    const out = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }

  it('кадр 200 мс — десять пакетов по 20 мс, номер кадра сохраняется, звук декодируется обратно', async () => {
    const source = voice(FRAME_SAMPLES * 5)
    const frames = await encodeSpeech(
      [0, 1, 2, 3, 4].map((i) => source.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES)),
    )

    expect(frames).toHaveLength(5)
    frames.forEach((frame, sequence) => {
      expect(frame.readUInt8(0)).toBe(AudioFrameKind.Tts)
      expect(frame.readUInt32BE(1)).toBe(sequence)
      const packets = packetsOf(frame)
      expect(packets).toHaveLength(10)
      for (const packet of packets) expect(packet.length).toBeGreaterThan(0)
    })
    // About 24 kbit/s: 200 ms is some 600 bytes, against 9605 for PCM16.
    const bytes = frames.reduce((total, frame) => total + frame.length, 0)
    expect(bytes / 5).toBeLessThan(1000)

    const decoded = decode(frames)
    expect(decoded.length).toBe(source.length)
    // The codec reshapes the waveform but keeps the loudness of the speech.
    const ratio = rms(decoded, 2400) / rms(source, 2400)
    expect(ratio).toBeGreaterThan(0.7)
    expect(ratio).toBeLessThan(1.3)
  })

  it('короткий кадр (конец фразы) оставляет хвост до следующего, а последний хвост уходит отдельным кадром', async () => {
    // 200 ms, then 1000 samples (2 packets and 40 samples over), then 200 ms: 10, 2, 10 packets, and the
    // 40 samples left at the end make one more packet in a frame numbered after the last.
    const frames = await encodeSpeech([voice(FRAME_SAMPLES), voice(1000, 4800), voice(FRAME_SAMPLES, 5800)])

    expect(frames.map((frame) => frame.readUInt32BE(1))).toEqual([0, 1, 2, 3])
    expect(frames.map((frame) => packetsOf(frame).length)).toEqual([10, 2, 10, 1])
    expect(decode(frames).length).toBe((10 + 2 + 10 + 1) * PACKET_SAMPLES)
  })

  it('кадр короче пакета ничего не отправляет: его сэмплы ждут следующего', async () => {
    const encoder = createSpeechEncoder('opus', settings, () => pool)
    expect(await encoder.frame(agentFrame(0, voice(100)))).toBeNull()
    const next = (await encoder.frame(agentFrame(1, voice(FRAME_SAMPLES)))) as Buffer
    expect(packetsOf(next)).toHaveLength(10)
    const tail = (await encoder.finish()) as Buffer
    expect(tail.readUInt32BE(1)).toBe(2)
    expect(packetsOf(tail)).toHaveLength(1)
  })

  it('речь без кадров ничего не дописывает в конце', async () => {
    expect(createSpeechEncoder('opus', settings, () => pool).finish()).toBeNull()
  })

  it('много речей сразу: у каждой свой кодер, кадры каждой приходят по порядку', async () => {
    const speeches = await Promise.all(
      [0, 1, 2, 3].map((speech) =>
        encodeSpeech([0, 1, 2].map((i) => voice(FRAME_SAMPLES, speech * 1000 + i * FRAME_SAMPLES))),
      ),
    )
    for (const frames of speeches) {
      expect(frames.map((frame) => frame.readUInt32BE(1))).toEqual([0, 1, 2])
      expect(decode(frames).length).toBe(3 * FRAME_SAMPLES)
    }
  })

  it('кодер не держит основной поток: кадры отдаются в поток сразу, и пока он кодирует, таймеры идут', async () => {
    const encoder = createSpeechEncoder('opus', settings, () => pool)
    const frames = Array.from({ length: 25 }, (_, i) =>
      agentFrame(i, voice(FRAME_SAMPLES, i * FRAME_SAMPLES)),
    )
    let ticks = 0
    const timer = setInterval(() => (ticks += 1), 0)
    const started = performance.now()
    const pending = frames.map((frame) => encoder.frame(frame))
    const handedOver = performance.now() - started
    await Promise.all(pending)
    const encoded = performance.now() - started
    clearInterval(timer)
    // Five seconds of speech: the main thread only copied the frames over, the encoding happened elsewhere.
    expect(handedOver).toBeLessThan(encoded / 2)
    expect(ticks).toBeGreaterThan(0)
    encoder.close()
  })
})

describe('порядок кадров к клиенту', () => {
  it('готовое уходит сразу, в том же такте, пока впереди ничего не ждёт', () => {
    const sent: string[] = []
    const queue = new InOrder(() => {})
    queue.push('a', (value) => sent.push(value))
    queue.push('b', (value) => sent.push(value))
    expect(sent).toEqual(['a', 'b'])
  })

  it('за ожидающим кадром всё встаёт в очередь: tts_end не обгоняет последний звук', async () => {
    const sent: string[] = []
    const queue = new InOrder(() => {})
    let release!: (value: string) => void
    queue.push(new Promise<string>((resolve) => (release = resolve)), (value) => sent.push(value))
    queue.push(Promise.resolve('audio 2'), (value) => sent.push(value))
    queue.push('tts_end', (value) => sent.push(value))
    await Promise.resolve()
    expect(sent).toEqual([])

    release('audio 1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual(['audio 1', 'audio 2', 'tts_end'])

    // Once the queue is empty, ready frames go at once again.
    queue.push('assistant_start', (value) => sent.push(value))
    expect(sent.at(-1)).toBe('assistant_start')
  })

  it('кадр, который отказал раньше того, что стоит перед ним, не остаётся без обработчика', async () => {
    const sent: string[] = []
    const errors: unknown[] = []
    const queue = new InOrder((error) => errors.push(error))
    queue.push(new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 20)), (value) =>
      sent.push(value),
    )
    queue.push(
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('worker died')), 5)),
      (value) => sent.push(value),
    )
    queue.push('tts_end', (value) => sent.push(value))
    // An unhandled rejection would fail the whole test run; here it must be reported once, in its turn.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(sent).toEqual(['slow', 'tts_end'])
    expect(errors).toHaveLength(1)
  })

  it('отказ кодера пропускает его кадр, остальные идут; после stop не уходит ничего', async () => {
    const sent: string[] = []
    const errors: unknown[] = []
    const queue = new InOrder((error) => errors.push(error))
    queue.push(Promise.reject(new Error('worker died')), (value: string) => sent.push(value))
    queue.push('tts_end', (value) => sent.push(value))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual(['tts_end'])
    expect(errors).toHaveLength(1)

    queue.push(new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5)), (value) =>
      sent.push(value),
    )
    queue.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toEqual(['tts_end'])
  })
})
