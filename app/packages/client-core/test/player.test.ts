import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_FRAME_HEADER_BYTES, AudioFrameKind } from '@ryadom/contracts/api/dialogs'
import { VoicePlayer } from '../src/voice/player'

/** A speech frame: kind, sequence number, then little-endian PCM16 samples. */
function ttsFrame(samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + samples.length * 2)
  const view = new DataView(buffer)
  view.setUint8(0, AudioFrameKind.Tts)
  view.setUint32(1, 0, false)
  samples.forEach((sample, index) => view.setInt16(AUDIO_FRAME_HEADER_BYTES + index * 2, sample, true))
  return buffer
}

function stubAudio() {
  const played: { samples: Float32Array; at: number; source: { onended: (() => void) | null } }[] = []
  class FakeContext {
    state = 'running'
    currentTime = 1
    destination = {}
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length)
      return { duration: length / 24_000, getChannelData: () => data, data }
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
        buffer: null as { data: Float32Array } | null,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        stop: vi.fn(),
        start(at: number) {
          played.push({ samples: source.buffer!.data, at, source })
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

afterEach(() => vi.unstubAllGlobals())

describe('VoicePlayer', () => {
  it('кадр озвучки с 5-байтовым заголовком декодируется: сэмплы стоят по нечётному смещению', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()

    player.enqueue(ttsFrame([0, 16384, -16384, 32767]))

    expect(played).toHaveLength(1)
    expect([...played[0]!.samples]).toEqual([0, 0.5, -0.5, 32767 / 0x8000])
  })

  it('кадры встают друг за другом без щелчков и зазоров', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()

    player.enqueue(ttsFrame(new Array(2400).fill(1)))
    player.enqueue(ttsFrame(new Array(2400).fill(1)))

    expect(played[1]!.at).toBeCloseTo(played[0]!.at + 0.1, 5)
  })

  it('без unlock (человек только пишет) ничего не играет', () => {
    const played = stubAudio()
    new VoicePlayer().enqueue(ttsFrame([1, 2, 3]))
    expect(played).toHaveLength(0)
  })

  it('говорит, пока в очереди есть озвучка, и тогда же отдаёт громкость', async () => {
    stubAudio()
    const player = new VoicePlayer()
    await player.unlock()
    expect(player.speaking).toBe(false)
    expect(player.level()).toBe(0)

    player.enqueue(ttsFrame([1, 2, 3]))
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

    player.enqueue(ttsFrame([1, 2, 3]))
    player.enqueue(ttsFrame([4, 5, 6]))
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
    player.enqueue(ttsFrame([1, 2, 3]))
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
    player.enqueue(ttsFrame([1, 2, 3]))
    player.stop()

    // The rest of the interrupted message is still on its way.
    player.enqueue(ttsFrame([4, 5, 6]))
    expect(played).toHaveLength(1)

    // A new message begins: its frames play.
    player.begin()
    player.enqueue(ttsFrame([7, 8, 9]))
    expect(played).toHaveLength(2)
  })

  it('чужие виды кадров и пустые кадры игнорируются', async () => {
    const played = stubAudio()
    const player = new VoicePlayer()
    await player.unlock()

    const user = ttsFrame([1, 2, 3])
    new DataView(user).setUint8(0, AudioFrameKind.User)
    player.enqueue(user)
    player.enqueue(new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES))

    expect(played).toHaveLength(0)
  })
})
