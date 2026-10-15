import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrophoneDeniedError, startCapture } from '../src/voice/capture'
import { PRE_ROLL_MS } from '../src/voice/turn-detector'

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
  label: string
  readyState: 'live' | 'ended'
  onended: (() => void) | null
  getSettings(): { deviceId: string }
}

/** A microphone's stream; `ended()` is the device going away by itself. */
function fakeStream(deviceId: string, label: string, count = 1) {
  const tracks: FakeTrack[] = Array.from({ length: count }, () => {
    const track: FakeTrack = {
      label,
      readyState: 'live',
      onended: null,
      getSettings: () => ({ deviceId }),
      stop: vi.fn(() => {
        track.readyState = 'ended'
      }),
    }
    return track
  })
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
    ended() {
      for (const track of tracks) {
        track.readyState = 'ended'
        track.onended?.()
      }
    },
  }
}

type Stream = ReturnType<typeof fakeStream>

interface Audio {
  closed: number
  tracks: FakeTrack[]
  /** The first stream opened. */
  stream: Stream
  /** What each `getUserMedia` call asked for. */
  asked: MediaStreamConstraints[]
  /** The streams each source node was made from, and whether it is still connected. */
  sources: { stream: Stream; connected: boolean }[]
  /** The worklet's port: `emit` plays a 100 ms frame from the audio thread. */
  emit(samples: Int16Array): void
}

const DESKTOP = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 }

/** The device id a `getUserMedia` call asked for, if any. */
const deviceAsked = (constraints: MediaStreamConstraints | undefined) =>
  (constraints?.audio as MediaTrackConstraints | undefined)?.deviceId

/** An error as the browser names it. */
function named(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

/**
 * The browser's audio stack, with a switch for the step that fails. `open` answers each `getUserMedia`
 * after the first: by default a new microphone named after the device asked for.
 */
function stubAudio(
  failAt?: 'context' | 'module' | 'node',
  open: (constraints: MediaStreamConstraints) => Stream = (constraints) => {
    const wanted = (deviceAsked(constraints) as { exact?: string } | undefined)?.exact ?? 'default'
    return fakeStream(wanted, `Микрофон ${wanted}`)
  },
): Audio {
  let port: { onmessage: ((event: { data: Int16Array }) => void) | null } | null = null
  const first = fakeStream('mic-1', 'Встроенный микрофон', 2)
  const audio: Audio = {
    closed: 0,
    tracks: first.tracks,
    stream: first,
    asked: [],
    sources: [],
    emit: (samples) => port?.onmessage?.({ data: samples }),
  }

  class FakeContext {
    audioWorklet = {
      addModule: async () => {
        if (failAt === 'module') throw new Error('worklet 404')
      },
    }
    constructor() {
      if (failAt === 'context') throw new Error('too many AudioContexts')
    }
    createMediaStreamSource(stream: Stream) {
      const entry = { stream, connected: false }
      audio.sources.push(entry)
      return {
        connect: vi.fn(() => {
          entry.connected = true
        }),
        disconnect: vi.fn(() => {
          entry.connected = false
        }),
      }
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

  vi.stubGlobal('navigator', {
    ...DESKTOP,
    mediaDevices: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        audio.asked.push(constraints)
        return audio.asked.length === 1 ? first : open(constraints)
      },
    },
  })
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorklet)
  return audio
}

/** Replaces only `getUserMedia`, keeping the rest of the stub. */
function stubGetUserMedia(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<unknown>,
  platform: { userAgent: string; maxTouchPoints: number } = DESKTOP,
) {
  vi.stubGlobal('navigator', { ...platform, mediaDevices: { getUserMedia } })
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
    stubGetUserMedia(async () => {
      throw new Error('NotAllowedError')
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

describe('startCapture: выбор микрофона', () => {
  it('без выбора микрофон выбирает браузер', async () => {
    const audio = stubAudio()
    await startCapture(() => undefined)
    expect(deviceAsked(audio.asked[0])).toBeUndefined()
  })

  it('открывается именно выбранный микрофон, а не какой захочет браузер', async () => {
    const audio = stubAudio()
    await startCapture(() => undefined, { deviceId: 'usb-mic' })
    expect(deviceAsked(audio.asked[0])).toEqual({ exact: 'usb-mic' })
  })

  it('на iPhone выбор — пожелание: система ведёт микрофон вместе с динамиком', async () => {
    const audio = stubAudio()
    stubGetUserMedia(
      async (constraints) => {
        audio.asked.push(constraints)
        return audio.stream
      },
      { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 },
    )
    await startCapture(() => undefined, { deviceId: 'airpods' })
    expect(deviceAsked(audio.asked[0])).toEqual({ ideal: 'airpods' })
  })

  it.each(['OverconstrainedError', 'NotFoundError'])(
    'выбранного микрофона нет (%s) — открывается тот, что выберет браузер',
    async (failure) => {
      const audio = stubAudio()
      const fallback = fakeStream('default', 'Микрофон по умолчанию')
      stubGetUserMedia(async (constraints) => {
        audio.asked.push(constraints)
        if (deviceAsked(constraints)) throw named(failure)
        return fallback
      })
      const capture = await startCapture(() => undefined, { deviceId: 'unplugged' })
      expect(audio.asked.map(deviceAsked)).toEqual([{ exact: 'unplugged' }, undefined])
      expect(capture.device()).toEqual({ id: 'default', label: 'Микрофон по умолчанию' })
    },
  )

  it('отказ в доступе при выбранном микрофоне — отказ, а не повод открыть другой', async () => {
    const asked: MediaStreamConstraints[] = []
    stubGetUserMedia(async (constraints) => {
      asked.push(constraints)
      throw named('NotAllowedError')
    })
    await expect(startCapture(() => undefined, { deviceId: 'usb-mic' })).rejects.toBeInstanceOf(
      MicrophoneDeniedError,
    )
    expect(asked).toHaveLength(1)
  })

  it('device() называет микрофон, который слушает', async () => {
    stubAudio()
    const capture = await startCapture(() => undefined)
    expect(capture.device()).toEqual({ id: 'mic-1', label: 'Встроенный микрофон' })
  })
})

describe('startCapture: смена микрофона на ходу', () => {
  it('новый микрофон подключается к тому же конвейеру, старый отпускается', async () => {
    const audio = stubAudio()
    const capture = await startCapture(() => undefined)

    await capture.switchDevice('usb-mic')

    expect(deviceAsked(audio.asked[1])).toEqual({ exact: 'usb-mic' })
    for (const track of audio.tracks) expect(track.stop).toHaveBeenCalledOnce()
    expect(audio.sources.map((source) => source.connected)).toEqual([false, true])
    expect(capture.device()).toEqual({ id: 'usb-mic', label: 'Микрофон usb-mic' })
    // The conversation goes on: nothing was closed.
    expect(audio.closed).toBe(0)
  })

  it('кадры и их нумерация идут дальше, шлюз остаётся каким был', async () => {
    const audio = stubAudio()
    const sent: ArrayBuffer[] = []
    const capture = await startCapture((frame) => sent.push(frame), { gated: true })
    capture.open()
    audio.emit(Int16Array.of(1))

    await capture.switchDevice('usb-mic')
    audio.emit(Int16Array.of(2))

    expect(sent.map(firstSampleOf).slice(-2)).toEqual([1, 2])
    const numbers = sent.map(sequenceOf)
    expect(numbers).toEqual(numbers.map((_, i) => i))
  })

  it('не открылся новый — остаётся старый, а экран узнаёт об ошибке', async () => {
    const audio = stubAudio(undefined, () => {
      throw named('NotReadableError')
    })
    const capture = await startCapture(() => undefined)

    await expect(capture.switchDevice('busy-mic')).rejects.toThrow('NotReadableError')

    expect(audio.tracks[0]?.stop).not.toHaveBeenCalled()
    expect(audio.sources.map((source) => source.connected)).toEqual([true])
    expect(capture.device().id).toBe('mic-1')
  })

  it('эхоподавление: по умолчанию обычное, «all» — когда звук идёт не в системный динамик', async () => {
    const audio = stubAudio()
    await startCapture(() => undefined, { echoCancellation: 'all' })
    expect((audio.asked[0]?.audio as MediaTrackConstraints).echoCancellation).toBe('all')
  })

  it('смена режима эха открывает тот же микрофон заново, а тот же режим ничего не трогает', async () => {
    const audio = stubAudio()
    const capture = await startCapture(() => undefined)

    await capture.setEchoCancellation(true)
    expect(audio.asked).toHaveLength(1)

    await capture.setEchoCancellation('all')
    const asked = audio.asked[1]?.audio as MediaTrackConstraints
    expect(asked.echoCancellation).toBe('all')
    expect(asked.deviceId).toEqual({ exact: 'mic-1' })

    // A switch keeps the mode it is in.
    await capture.switchDevice('usb-mic')
    expect((audio.asked[2]?.audio as MediaTrackConstraints).echoCancellation).toBe('all')
  })

  it('после stop() смена ничего не открывает', async () => {
    const audio = stubAudio()
    const capture = await startCapture(() => undefined)
    await capture.stop()
    await capture.switchDevice('usb-mic')
    expect(audio.asked).toHaveLength(1)
  })
})

describe('startCapture: микрофон пропал', () => {
  it('выдернули — экран узнаёт', async () => {
    const audio = stubAudio()
    const onDeviceLost = vi.fn()
    await startCapture(() => undefined, { onDeviceLost })
    audio.stream.ended()
    expect(onDeviceLost).toHaveBeenCalled()
  })

  it('свой stop() и своя смена микрофона — не пропажа', async () => {
    const audio = stubAudio()
    const onDeviceLost = vi.fn()
    const capture = await startCapture(() => undefined, { onDeviceLost })

    await capture.switchDevice('usb-mic')
    // The old one ending afterwards (iOS ends it when another opens) is not about the one in use.
    audio.stream.ended()
    await capture.stop()

    expect(onDeviceLost).not.toHaveBeenCalled()
  })

  it('пропал тот, на который переключились, — экран узнаёт', async () => {
    let opened: Stream | null = null
    stubAudio(undefined, () => {
      opened = fakeStream('usb-mic', 'USB')
      return opened
    })
    const onDeviceLost = vi.fn()
    const capture = await startCapture(() => undefined, { onDeviceLost })
    await capture.switchDevice('usb-mic')

    opened!.ended()

    expect(onDeviceLost).toHaveBeenCalledOnce()
  })
})
