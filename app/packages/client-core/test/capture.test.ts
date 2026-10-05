import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrophoneDeniedError, startCapture } from '../src/voice/capture'

interface Audio {
  stopped: number
  closed: number
  tracks: { stop: ReturnType<typeof vi.fn> }[]
}

/** The browser's audio stack, with a switch for the step that fails. */
function stubAudio(failAt?: 'context' | 'module' | 'node'): Audio {
  const audio: Audio = { stopped: 0, closed: 0, tracks: [{ stop: vi.fn() }, { stop: vi.fn() }] }
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
    port: { onmessage: unknown } = { onmessage: null }
    constructor() {
      if (failAt === 'node') throw new Error('no such processor')
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
})
