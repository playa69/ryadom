import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listAudioDevices,
  readAudioDevices,
  resolveAudioDevice,
  watchAudioDevices,
  writeAudioDevice,
  type AudioDeviceOption,
} from '../src/voice/devices'

function info(kind: MediaDeviceKind, deviceId: string, label: string, groupId = ''): MediaDeviceInfo {
  return { kind, deviceId, label, groupId, toJSON: () => ({}) } as MediaDeviceInfo
}

/** What Chrome on Windows lists for a laptop with a Bluetooth headset and an audio interface. */
const WINDOWS_CHROME = [
  info('audioinput', 'default', 'Default - Headset (JBL) (Bluetooth)', 'g-jbl'),
  info('audioinput', 'communications', 'Communications - Headset (JBL) (Bluetooth)', 'g-jbl'),
  info('audioinput', 'id-umc', 'IN 1 (BEHRINGER UMC 202HD)', 'g-umc'),
  info('audioinput', 'id-jbl', 'Headset (JBL) (Bluetooth)', 'g-jbl'),
  info('videoinput', 'cam', 'HD Webcam', 'g-cam'),
  info('audiooutput', 'default', 'Default - Headphones (JBL) (Bluetooth)', 'g-jbl-out'),
  info('audiooutput', 'communications', 'Communications - Headphones (JBL) (Bluetooth)', 'g-jbl-out'),
  info('audiooutput', 'id-jbl-out', 'Headphones (JBL) (Bluetooth)', 'g-jbl-out'),
  info('audiooutput', 'id-hdmi', 'DELL U2720Q (NVIDIA High Definition Audio)', 'g-hdmi'),
]

function stubDevices(devices: MediaDeviceInfo[], { outputs = true } = {}) {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => devices } })
  class FakeContext {}
  if (outputs) Object.assign(FakeContext.prototype, { setSinkId: async () => undefined })
  vi.stubGlobal('AudioContext', FakeContext)
}

function stubStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  return store
}

afterEach(() => vi.unstubAllGlobals())

describe('listAudioDevices', () => {
  it('«как в системе» первым и с именем устройства, на которое смотрит; «связь» не дублирует его', async () => {
    stubDevices(WINDOWS_CHROME)
    const { inputs, outputs } = await listAudioDevices()
    expect(inputs).toEqual([
      { id: 'default', label: 'Headset (JBL) (Bluetooth)', system: true },
      { id: 'id-umc', label: 'IN 1 (BEHRINGER UMC 202HD)', system: false },
      { id: 'id-jbl', label: 'Headset (JBL) (Bluetooth)', system: false },
    ])
    expect(outputs.map((output) => output.id)).toEqual(['default', 'id-jbl-out', 'id-hdmi'])
    expect(outputs[0]).toMatchObject({ label: 'Headphones (JBL) (Bluetooth)', system: true })
  })

  it('без парного устройства имя «как в системе» берётся из подписи браузера без приставки', async () => {
    stubDevices([
      info('audioinput', 'default', 'По умолчанию – Микрофон (Realtek)'),
      info('audioinput', 'x', 'USB'),
    ])
    const { inputs } = await listAudioDevices()
    expect(inputs[0]).toEqual({ id: 'default', label: 'Микрофон (Realtek)', system: true })
  })

  it('до разрешения микрофона браузер прячет устройства — выбирать не из чего', async () => {
    stubDevices([info('audioinput', '', ''), info('audiooutput', '', '')])
    expect(await listAudioDevices()).toMatchObject({ inputs: [], outputs: [] })
  })

  it('безымянные устройства получают номер', async () => {
    stubDevices([info('audioinput', 'a', ''), info('audioinput', 'b', '')])
    const { inputs } = await listAudioDevices()
    expect(inputs.map((input) => input.label)).toEqual(['Микрофон 1', 'Микрофон 2'])
  })

  it('где страница не выбирает динамик (Safari, Firefox, iPhone), динамиков в списке нет', async () => {
    stubDevices(WINDOWS_CHROME, { outputs: false })
    const { inputs, outputs } = await listAudioDevices()
    expect(inputs).toHaveLength(3)
    expect(outputs).toEqual([])
  })

  it('браузер без списка устройств — пустой список, а не ошибка', async () => {
    const nothing = { inputs: [], outputs: [], browserPick: { input: null, output: null } }
    vi.stubGlobal('navigator', {})
    expect(await listAudioDevices()).toEqual(nothing)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => {
          throw new Error('SecurityError')
        },
      },
    })
    expect(await listAudioDevices()).toEqual(nothing)
  })

  it('без выбора браузер открывает то, что перечисляет первым, — и это не обязательно «как в системе»', async () => {
    // Chrome with its own preferred microphone: it is listed first, and the system's default further down.
    stubDevices([WINDOWS_CHROME[2]!, WINDOWS_CHROME[3]!, WINDOWS_CHROME[0]!, ...WINDOWS_CHROME.slice(5)])
    const { browserPick } = await listAudioDevices()
    expect(browserPick).toEqual({ input: 'id-umc', output: 'default' })
  })
})

describe('resolveAudioDevice', () => {
  const options: AudioDeviceOption[] = [
    { id: 'default', label: 'Headset (JBL)', system: true },
    { id: 'new-id', label: 'USB Mic', system: false },
    { id: 'id-jbl', label: 'Headset (JBL)', system: false },
  ]

  it('тот же id — то же устройство', () => {
    expect(resolveAudioDevice({ id: 'id-jbl', label: 'Headset (JBL)' }, options)?.id).toBe('id-jbl')
    expect(resolveAudioDevice({ id: 'default', label: 'Что угодно' }, options)?.id).toBe('default')
  })

  it('id сменился (данные сайта очищены) — находится по имени, но не «как в системе»', () => {
    expect(resolveAudioDevice({ id: 'old-id', label: 'USB Mic' }, options)?.id).toBe('new-id')
    expect(resolveAudioDevice({ id: 'old-jbl', label: 'Headset (JBL)' }, options)?.id).toBe('id-jbl')
  })

  it('выбранного нет (выключен, выдернут) или выбора не было — решает браузер', () => {
    expect(resolveAudioDevice({ id: 'gone', label: 'AirPods' }, options)).toBeNull()
    expect(resolveAudioDevice(null, options)).toBeNull()
  })
})

describe('выбор хранится в этом браузере', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = stubStorage()
  })

  it('микрофон и динамик запоминаются по отдельности', () => {
    writeAudioDevice('k', 'input', { id: 'id-umc', label: 'IN 1' })
    writeAudioDevice('k', 'output', { id: 'id-hdmi', label: 'DELL' })
    expect(readAudioDevices('k')).toEqual({
      input: { id: 'id-umc', label: 'IN 1' },
      output: { id: 'id-hdmi', label: 'DELL' },
    })
  })

  it('хранится только id и имя, а без выбора ключ убирается', () => {
    writeAudioDevice('k', 'input', { id: 'a', label: 'A', system: false } as AudioDeviceOption)
    expect(JSON.parse(store.get('k')!)).toEqual({ input: { id: 'a', label: 'A' }, output: null })
    writeAudioDevice('k', 'input', null)
    expect(store.has('k')).toBe(false)
  })

  it('мусор в хранилище — нет выбора', () => {
    store.set('k', '{"input":{"id":""},"output":42}')
    expect(readAudioDevices('k')).toEqual({ input: null, output: null })
    store.set('k', 'не json')
    expect(readAudioDevices('k')).toEqual({ input: null, output: null })
  })

  it('хранилище недоступно — нет выбора и нет ошибки', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(readAudioDevices('k')).toEqual({ input: null, output: null })
    expect(() => writeAudioDevice('k', 'input', { id: 'a', label: 'A' })).not.toThrow()
  })
})

describe('watchAudioDevices', () => {
  it('подписывается на devicechange и отписывается', () => {
    const add = vi.fn()
    const remove = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { addEventListener: add, removeEventListener: remove } })
    const onChange = () => undefined
    const stop = watchAudioDevices(onChange)
    expect(add).toHaveBeenCalledWith('devicechange', onChange)
    stop()
    expect(remove).toHaveBeenCalledWith('devicechange', onChange)
  })
})
