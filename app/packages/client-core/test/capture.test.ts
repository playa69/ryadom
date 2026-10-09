import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrophoneDeniedError, startCapture } from '../src/voice/capture'
import { PRE_ROLL_MS } from '../src/voice/turn-detector'

interface Audio {
  stopped: number
  closed: number
  tracks: { stop: ReturnType<typeof vi.fn> }[]
  /** The worklet's port: `emit` plays a 100 ms frame from the audio thread. */
  emit(samples: Int16Array): void
}

/** The browser's audio stack, with a switch for the step that fails. */
function stubAudio(failAt?: 'context' | 'module' | 'node'): Audio {
  let port: { onmessage: ((event: { data: Int16Array }) => void) | null } | null = null
  const audio: Audio = {
    stopped: 0,
    closed: 0,
    tracks: [{ stop: vi.fn() }, { stop: vi.fn() }],
    emit: (samples) => port?.onmessage?.({ data: samples }),
  }
  const stream = { getTracks: () => audio.tracks }

  class FakeContext {
    audioWorklet = {
      addModule: async () => {
        if (failAt === 'module') throw new Error('worklet 404')
      },
    }
    constructor() {
      if (failAt === 'context') throw new Error('too many AudioContexts')
    }
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() }
    }
    createAnalyser() {
      return {
        fftSize: 0,
        // Fills the frame the screen passes in: a constant 192 is a steady half-scale wave.
        getByteTimeDomainData: (bins: Uint8Array) => bins.fill(192),
      }
    }
    async close() {
      audio.closed += 1
    }
  }

  class FakeWorklet {
    port: { onmessage: ((event: { data: Int16Array }) => void) | null } = { onmessage: null }
    constructor() {
      if (failAt === 'node') throw new Error('no such processor')
      port = this.port
    }
    disconnect() {}
  }

  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } })
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorklet)
  return audio
}

afterEach(() => vi.unstubAllGlobals())

describe('startCapture', () => {
  it.each(['context', 'module', 'node'] as const)(
    'сбой на шаге «%s» после getUserMedia отпускает микрофон',
    async (step) => {
      const audio = stubAudio(step)

      await expect(startCapture(() => undefined)).rejects.toThrow()

      for (const track of audio.tracks) expect(track.stop).toHaveBeenCalledOnce()
      // A context that was never created has nothing to close.
      expect(audio.closed).toBe(step === 'context' ? 0 : 1)
    },
  )

  it('сбой настройки — не отказ в доступе: экран покажет другую фразу', async () => {
    stubAudio('module')
    await expect(startCapture(() => undefined)).rejects.not.toBeInstanceOf(MicrophoneDeniedError)
  })

  it('отказ в доступе к микрофону — MicrophoneDeniedError', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => {
          throw new Error('NotAllowedError')
        },
      },
    })
    await expect(startCapture(() => undefined)).rejects.toBeInstanceOf(MicrophoneDeniedError)
  })

  it('stop() отпускает дорожки и закрывает контекст', async () => {
    const audio = stubAudio()
    const capture = await startCapture(() => undefined)
    expect(audio.tracks[0]?.stop).not.toHaveBeenCalled()

    await capture.stop()
    for (const track of audio.tracks) expect(track.stop).toHaveBeenCalledOnce()
    expect(audio.closed).toBe(1)
  })

  it('level() читает громкость с анализатора', async () => {
    stubAudio()
    const capture = await startCapture(() => undefined)
    // 192 is half of full scale above the 128 midline: RMS 0.5, stretched and capped at 1.
    expect(capture.level()).toBe(1)
  })

  it('без шлюза кадры идут сразу, по порядку', async () => {
    const audio = stubAudio()
    const sent: ArrayBuffer[] = []
    await startCapture((frame) => sent.push(frame))
    audio.emit(Int16Array.of(1))
    audio.emit(Int16Array.of(2))
    expect(sent.map(sequenceOf)).toEqual([0, 1])
  })
})

/** Frame header: kind (1 byte), then the sequence number, big-endian. */
const sequenceOf = (frame: ArrayBuffer) => new DataView(frame).getUint32(1, false)
const firstSampleOf = (frame: ArrayBuffer) => new DataView(frame).getInt16(5, true)

describe('startCapture: без рук (gated)', () => {
  it('до open() тишина не уходит, а open() отдаёт последние PRE_ROLL_MS и дальше живые кадры', async () => {
    const audio = stubAudio()
    const sent: ArrayBuffer[] = []
    const capture = await startCapture((frame) => sent.push(frame), { gated: true })
    for (let i = 1; i <= 20; i++) audio.emit(Int16Array.of(i))
    expect(sent).toEqual([])

    capture.open()
    const kept = PRE_ROLL_MS / 100
    // The held frames are the latest ones, in order: the first syllable comes before the detector fires.
    expect(sent.map(firstSampleOf)).toEqual(Array.from({ length: kept }, (_, i) => 20 - kept + 1 + i))
    audio.emit(Int16Array.of(21))
    expect(sent.map(firstSampleOf).at(-1)).toBe(21)
    // Numbered from zero in the order they leave, without holes for the frames that never did.
    expect(sent.map(sequenceOf)).toEqual(Array.from({ length: kept + 1 }, (_, i) => i))
  })

  it('close() снова держит кадры при себе, а следующий open() не повторяет старые', async () => {
    const audio = stubAudio()
    const sent: ArrayBuffer[] = []
    const capture = await startCapture((frame) => sent.push(frame), { gated: true })
    capture.open()
    audio.emit(Int16Array.of(1))
    capture.close()
    audio.emit(Int16Array.of(2))
    expect(sent.map(firstSampleOf)).toEqual([1])

    capture.open()
    expect(sent.map(firstSampleOf)).toEqual([1, 2])
    expect(sent.map(sequenceOf)).toEqual([0, 1])
  })
})
