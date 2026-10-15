import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EchoCancellation, VoiceCapture } from '../src/voice/capture'
import type { VoicePlayer } from '../src/voice/player'
import { AUDIO_DEVICE_TEXT, AudioRouting } from '../src/voice/routing'

const KEY = 'test.audio-devices'

function info(kind: MediaDeviceKind, deviceId: string, label: string, groupId = ''): MediaDeviceInfo {
  return { kind, deviceId, label, groupId, toJSON: () => ({}) } as MediaDeviceInfo
}

/** Chrome on Windows: an audio interface Chrome prefers (listed first), a Bluetooth headset the system uses. */
function desk({ headset = true, systemIsHeadset = true } = {}): MediaDeviceInfo[] {
  const system = systemIsHeadset ? ['Headset (JBL)', 'g-jbl'] : ['IN 1 (UMC)', 'g-umc']
  return [
    info('audioinput', 'id-umc', 'IN 1 (UMC)', 'g-umc'),
    ...(headset ? [info('audioinput', 'id-jbl', 'Headset (JBL)', 'g-jbl')] : []),
    info('audioinput', 'default', `Default - ${system[0]}`, system[1]),
    info('audiooutput', 'default', 'Default - Speakers (Realtek)', 'g-rt'),
    info('audiooutput', 'id-rt', 'Speakers (Realtek)', 'g-rt'),
    ...(headset ? [info('audiooutput', 'id-jbl-out', 'Headphones (JBL)', 'g-jbl-out')] : []),
  ]
}

let devices: MediaDeviceInfo[] = []
let onDeviceChange: (() => void) | null = null

function stubBrowser() {
  devices = desk()
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => devices,
      addEventListener: (_: string, listener: () => void) => (onDeviceChange = listener),
      removeEventListener: () => (onDeviceChange = null),
    },
  })
  class RoutableContext {}
  Object.assign(RoutableContext.prototype, { setSinkId: async () => undefined })
  vi.stubGlobal('AudioContext', RoutableContext)
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  return store
}

/** The capture as the routing sees it: which microphone it is on, and what it was asked to do. */
function fakeCapture(id = 'id-umc', label = 'IN 1 (UMC)') {
  let device = { id, label }
  const fake = {
    fail: false,
    echo: true as EchoCancellation,
    device: () => device,
    switchDevice: vi.fn(async (next: string | null) => {
      if (fake.fail) throw new Error('NotReadableError')
      const found = devices.find(
        (entry) => entry.kind === 'audioinput' && entry.deviceId === (next ?? 'default'),
      )
      device = { id: found?.deviceId ?? 'default', label: found?.label ?? '' }
    }),
    setEchoCancellation: vi.fn(async (mode: EchoCancellation) => {
      fake.echo = mode
    }),
  }
  return fake
}

function fakePlayer(missing: string[] = []) {
  let sink = ''
  return {
    output: () => sink,
    setOutput: vi.fn(async (id: string | null) => {
      if (id && missing.includes(id)) {
        sink = ''
        return false
      }
      sink = id ?? ''
      return true
    }),
  }
}

function routingWith(capture: ReturnType<typeof fakeCapture> | null, player = fakePlayer()) {
  const host = {
    capture: () => capture as unknown as VoiceCapture | null,
    player: () => player as unknown as VoicePlayer,
    changed: vi.fn(),
    notice: vi.fn(),
    inputGone: vi.fn(),
    lost: vi.fn(),
  }
  return { routing: new AudioRouting(KEY, host), host, player }
}

/** Plug devices in or out and let the burst of events settle. */
async function replug(next: MediaDeviceInfo[]) {
  devices = next
  onDeviceChange?.()
  await vi.advanceTimersByTimeAsync(400)
}

beforeEach(() => {
  stubBrowser()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AudioRouting: что показывает меню', () => {
  it('ничего не выбрано: отмечено то, что открывает браузер, — и видно, что это не гарнитура', async () => {
    const { routing } = routingWith(null)
    await routing.refresh()
    const view = routing.view()
    expect(view.input).toMatchObject({ id: 'id-umc', label: 'IN 1 (UMC)' })
    expect(view.inputs[0]).toMatchObject({ id: 'default', label: 'Headset (JBL)', system: true })
    expect(view.output).toMatchObject({ id: 'default', system: true })
    expect(view.choosable).toBe(true)
  })

  it('микрофон открыт — отмечен тот, что слушает', async () => {
    const { routing } = routingWith(fakeCapture('id-jbl', 'Headset (JBL)'))
    await routing.refresh()
    expect(routing.view().input?.id).toBe('id-jbl')
  })

  it('один микрофон и динамик не выбрать — меню не нужно', async () => {
    devices = [info('audioinput', 'mic', 'MacBook Microphone')]
    vi.stubGlobal('AudioContext', class {})
    const { routing } = routingWith(null)
    await routing.refresh()
    expect(routing.view().choosable).toBe(false)
  })
})

describe('AudioRouting: что получает микрофон при открытии', () => {
  it('без выбора решает браузер, эхо — как обычно', async () => {
    const { routing } = routingWith(null)
    expect(await routing.captureOptions()).toEqual({ deviceId: null, echoCancellation: true })
  })

  it('выбранный микрофон, если он здесь; если его нет — решает браузер', async () => {
    const { routing } = routingWith(null)
    await routing.choose('input', { id: 'id-jbl', label: 'Headset (JBL)', system: false })
    expect((await routing.captureOptions()).deviceId).toBe('id-jbl')

    devices = desk({ headset: false })
    expect((await routing.captureOptions()).deviceId).toBeNull()
  })

  it('до разрешения браузер прячет id — запомненный пробуется как есть', async () => {
    const { routing } = routingWith(null)
    await routing.choose('input', { id: 'id-jbl', label: 'Headset (JBL)', system: false })
    devices = [info('audioinput', '', '')]
    expect((await routing.captureOptions()).deviceId).toBe('id-jbl')
  })

  it('звук не в системный динамик — эхоподавление слушает всё, что играет компьютер', async () => {
    const { routing } = routingWith(null)
    await routing.choose('output', { id: 'id-jbl-out', label: 'Headphones (JBL)', system: false })
    expect((await routing.captureOptions()).echoCancellation).toBe('all')
    await routing.choose('output', { id: 'default', label: 'Speakers (Realtek)', system: true })
    expect((await routing.captureOptions()).echoCancellation).toBe(true)
  })
})

describe('AudioRouting: выбор в меню', () => {
  it('микрофон меняется на ходу и запоминается', async () => {
    const capture = fakeCapture()
    const { routing, host } = routingWith(capture)
    await routing.choose('input', { id: 'id-jbl', label: 'Headset (JBL)', system: false })
    expect(capture.switchDevice).toHaveBeenCalledWith('id-jbl')
    expect(JSON.parse(localStorage.getItem(KEY)!).input).toEqual({ id: 'id-jbl', label: 'Headset (JBL)' })
    expect(host.notice).not.toHaveBeenCalled()
  })

  it('выбранный микрофон не включился — остаётся прежний, и человек это слышит', async () => {
    const capture = fakeCapture()
    capture.fail = true
    const { routing, host } = routingWith(capture)
    await routing.choose('input', { id: 'id-jbl', label: 'Headset (JBL)', system: false })
    expect(host.notice).toHaveBeenCalledWith(AUDIO_DEVICE_TEXT.inputFailed('Headset (JBL)'))
  })

  it('динамик меняется на ходу; «как в системе» — пустой sink, который следует за системой', async () => {
    const capture = fakeCapture()
    const { routing, player } = routingWith(capture)
    await routing.choose('output', { id: 'id-jbl-out', label: 'Headphones (JBL)', system: false })
    expect(player.setOutput).toHaveBeenLastCalledWith('id-jbl-out')
    expect(capture.echo).toBe('all')

    await routing.choose('output', { id: 'default', label: 'Speakers (Realtek)', system: true })
    expect(player.setOutput).toHaveBeenLastCalledWith(null)
    expect(capture.echo).toBe(true)
  })

  it('динамик не принял звук — звук как в системе, и человек это слышит', async () => {
    const { routing, host } = routingWith(null, fakePlayer(['id-jbl-out']))
    await routing.choose('output', { id: 'id-jbl-out', label: 'Headphones (JBL)', system: false })
    expect(host.notice).toHaveBeenCalledWith(AUDIO_DEVICE_TEXT.outputFailed('Headphones (JBL)'))
  })

  it('applyOutput ставит запомненный динамик проигрывателю', async () => {
    const first = routingWith(null)
    await first.routing.choose('output', { id: 'id-jbl-out', label: 'Headphones (JBL)', system: false })
    const { routing, player } = routingWith(null)
    await routing.applyOutput()
    expect(player.setOutput).toHaveBeenCalledWith('id-jbl-out')
  })
})

describe('AudioRouting: устройства выдёргивают и подключают', () => {
  it('микрофон пропал — разговор переходит на системный и говорит об этом', async () => {
    const capture = fakeCapture('id-jbl', 'Headset (JBL)')
    const { routing, host } = routingWith(capture)
    devices = desk({ headset: false, systemIsHeadset: false })
    routing.deviceLost()
    await routing.refresh()
    expect(capture.switchDevice).toHaveBeenCalledWith('default')
    expect(host.notice).toHaveBeenCalledWith(AUDIO_DEVICE_TEXT.inputLost('Headset (JBL)', 'IN 1 (UMC)'))
    expect(host.lost).toHaveBeenCalledWith('input', true)
  })

  it('микрофонов не осталось — слушание на паузе', async () => {
    const capture = fakeCapture()
    capture.fail = true
    const { routing, host } = routingWith(capture)
    routing.deviceLost()
    await routing.refresh()
    expect(host.inputGone).toHaveBeenCalled()
    expect(host.notice).toHaveBeenCalledWith(AUDIO_DEVICE_TEXT.inputGone)
    expect(host.lost).toHaveBeenCalledWith('input', false)
  })

  it('выбранная гарнитура вернулась — разговор возвращается на неё', async () => {
    vi.useFakeTimers()
    const capture = fakeCapture('id-jbl', 'Headset (JBL)')
    const { routing, host } = routingWith(capture)
    await routing.choose('input', { id: 'id-jbl', label: 'Headset (JBL)', system: false })
    // The headset ran out of battery: the conversation went on through the system's microphone.
    devices = desk({ headset: false, systemIsHeadset: false })
    routing.deviceLost()
    await routing.refresh()
    expect(capture.device().id).toBe('default')
    capture.switchDevice.mockClear()
    const stop = routing.watch()

    await replug(desk())

    expect(capture.switchDevice).toHaveBeenCalledWith('id-jbl')
    expect(host.notice).toHaveBeenCalledWith(AUDIO_DEVICE_TEXT.inputBack('Headset (JBL)'))
    stop()
  })

  it('«как в системе», и система сменила устройство — микрофон открывается заново', async () => {
    vi.useFakeTimers()
    devices = desk({ systemIsHeadset: false })
    const capture = fakeCapture('default', 'Default - IN 1 (UMC)')
    const { routing, host } = routingWith(capture)
    await routing.refresh()
    const stop = routing.watch()

    await replug(desk({ systemIsHeadset: true }))

    expect(capture.switchDevice).toHaveBeenCalledWith('default')
    // Nothing the person chose changed: no notice.
    expect(host.notice).not.toHaveBeenCalled()
    stop()
  })

  it('выбранный динамик пропал — звук как в системе; вернулся — снова в него', async () => {
    vi.useFakeTimers()
    const capture = fakeCapture()
    const { routing, host, player } = routingWith(capture)
    await routing.choose('output', { id: 'id-jbl-out', label: 'Headphones (JBL)', system: false })
    const stop = routing.watch()

    await replug(desk({ headset: false, systemIsHeadset: false }))
    expect(player.output()).toBe('')
    expect(capture.echo).toBe(true)
    expect(host.notice).toHaveBeenLastCalledWith(AUDIO_DEVICE_TEXT.outputLost('Headphones (JBL)'))

    await replug(desk())
    expect(player.output()).toBe('id-jbl-out')
    expect(capture.echo).toBe('all')
    expect(host.notice).toHaveBeenLastCalledWith(AUDIO_DEVICE_TEXT.outputBack('Headphones (JBL)'))
    stop()
  })

  it('после stop() перестановки устройств ничего не трогают', async () => {
    vi.useFakeTimers()
    const capture = fakeCapture()
    const { routing } = routingWith(capture)
    await routing.choose('input', { id: 'id-jbl', label: 'Headset (JBL)', system: false })
    capture.switchDevice.mockClear()
    const stop = routing.watch()
    stop()
    await replug(desk())
    expect(capture.switchDevice).not.toHaveBeenCalled()
  })
})
