import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoicePlayer } from '../src/voice/player'
import type { PcmChunk } from '../src/voice/tts-decoder'

/** Decoded speech, as the socket hands it over: PCM16 values scaled to floats, 24 kHz unless said otherwise. */
function speech(samples: number[], sampleRate = 24_000): PcmChunk {
  return { samples: Float32Array.from(samples, (sample) => sample / 0x8000), sampleRate }
}

function stubAudio() {
  const played: {
    samples: Float32Array
    rate: number
    at: number
    source: { onended: (() => void) | null }
  }[] = []
  class FakeContext {
    state = 'running'
    currentTime = 1
    destination = {}
    createBuffer(_channels: number, length: number, rate: number) {
      const data = new Float32Array(length)
      return { duration: length / rate, getChannelData: () => data, data, rate }
    }
    createAnalyser() {
      return {
        fftSize: 0,
        connect: vi.fn(),
        getByteTimeDomainData: (bins: Uint8Array) => bins.fill(160),
      }
    }
    createBufferSource() {
      const source = {
        buffer: null as { data: Float32Array; rate: number } | null,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        stop: vi.fn(),
        start(at: number) {
          played.push({ samples: source.buffer!.data, rate: source.buffer!.rate, at, source })
        },
      }
      return source
    }
    async resume() {}
    async close() {}
  }
  vi.stubGlobal('AudioContext', FakeContext)
  return played
}

/** A context that can choose its speaker, as in Chromium; `missing` are speakers that are not there. */
function stubSinks(missing: string[] = []) {
  stubAudio()
  const Base = globalThis.AudioContext as unknown as new () => object
  const asked: string[] = []
  class RoutableContext extends Base {
    sinkId = ''
    async setSinkId(id: string) {
      asked.push(id)
      if (missing.includes(id)) throw new DOMException('not found', 'NotFoundError')
      this.sinkId = id
    }
  }
  vi.stubGlobal('AudioContext', RoutableContext)
  return { asked }
}

afterEach(() => vi.unstubAllGlobals())

describe('VoicePlayer', () => {
  it('декодированные сэмплы играют как есть, на своей частоте', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()

    player.enqueue(speech([0, 16384, -16384, 32767]))
    // Opus through WebCodecs may come back at 48 kHz.
    player.enqueue(speech([1, 2], 48_000))

    expect(played).toHaveLength(2)
    expect([...played[0]!.samples]).toEqual([0, 0.5, -0.5, 32767 / 0x8000])
    expect(played.map((entry) => entry.rate)).toEqual([24_000, 48_000])
  })

  it('куски встают друг за другом без щелчков и зазоров, какой бы длины они ни были', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()

    player.enqueue(speech(new Array(2400).fill(1)))
    player.enqueue(speech(new Array(2400).fill(1)))
    // 20 ms packets of Opus, at the rate WebCodecs gives them.
    player.enqueue(speech(new Array(960).fill(1), 48_000))
    player.enqueue(speech(new Array(960).fill(1), 48_000))

    expect(played[1]!.at).toBeCloseTo(played[0]!.at + 0.1, 5)
    expect(played[2]!.at).toBeCloseTo(played[1]!.at + 0.1, 5)
    expect(played[3]!.at).toBeCloseTo(played[2]!.at + 0.02, 5)
  })

  it('без unlock (человек только пишет) ничего не играет', () => {
    const played = stubAudio()
    new VoicePlayer().enqueue(speech([1, 2, 3]))
    expect(played).toHaveLength(0)
  })

  it('говорит, пока в очереди есть озвучка, и тогда же отдаёт громкость', async () => {
    stubAudio()
    const player = new VoicePlayer()
    await player.unlock()
    expect(player.speaking).toBe(false)
    expect(player.level()).toBe(0)

    player.enqueue(speech([1, 2, 3]))
    expect(player.speaking).toBe(true)
    expect(player.level()).toBeGreaterThan(0)

    // Interrupting drops the queue: the voice is over at once.
    player.stop()
    expect(player.speaking).toBe(false)
    expect(player.level()).toBe(0)
  })

  it('drained() готов, когда играть нечего, и ждёт, пока доиграет очередь', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()
    await expect(player.drained()).resolves.toBeUndefined()

    player.enqueue(speech([1, 2, 3]))
    player.enqueue(speech([4, 5, 6]))
    let done = false
    void player.drained().then(() => (done = true))

    played[0]!.source.onended?.()
    await Promise.resolve()
    expect(done).toBe(false)
    played[1]!.source.onended?.()
    await Promise.resolve()
    expect(done).toBe(true)
  })

  it('drained() готов и когда очередь сбросили перебиванием', async () => {
    stubAudio()
    const player = new VoicePlayer()
    await player.unlock()
    player.enqueue(speech([1, 2, 3]))
    let done = false
    void player.drained().then(() => (done = true))

    player.stop()
    await Promise.resolve()
    expect(done).toBe(true)
  })

  it('после перебивания кадры, что ещё летят, не играют — до начала следующей речи', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()
    player.enqueue(speech([1, 2, 3]))
    player.stop()

    // The rest of the interrupted message is still on its way.
    player.enqueue(speech([4, 5, 6]))
    expect(played).toHaveLength(1)

    // A new message begins: its frames play.
    player.begin()
    player.enqueue(speech([7, 8, 9]))
    expect(played).toHaveLength(2)
  })

  it('выбранный динамик ставится, когда контекст появляется, и меняется на ходу', async () => {
    const sinks = stubSinks()
    const player = new VoicePlayer()
    // Chosen before the first tap: there is no context yet to route.
    expect(await player.setOutput('id-hdmi')).toBe(true)
    await player.unlock()
    expect(player.output()).toBe('id-hdmi')

    expect(await player.setOutput(null)).toBe(true)
    expect(player.output()).toBe('')
    expect(sinks.asked).toEqual(['id-hdmi', ''])
  })

  it('выбранного динамика нет — голос идёт в системный, а не в тишину', async () => {
    const sinks = stubSinks(['gone'])
    const player = new VoicePlayer()
    await player.unlock()
    expect(await player.setOutput('gone')).toBe(false)
    expect(player.output()).toBe('')
  })

  it('где браузер не выбирает динамик, выбор не ломает воспроизведение', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    expect(await player.setOutput('id-hdmi')).toBe(false)
    expect(await player.setOutput(null)).toBe(true)
    await player.setOutput('id-hdmi')
    await player.unlock()
    player.enqueue(speech([1, 2, 3]))
    expect(played).toHaveLength(1)
    expect(player.output()).toBe('')
  })

  it('пустой кусок не играет', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()

    player.enqueue(speech([]))

    expect(played).toHaveLength(0)
    expect(player.speaking).toBe(false)
  })
})
