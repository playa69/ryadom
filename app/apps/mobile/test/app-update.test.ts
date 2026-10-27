/**
 * The client side of the version policy: what a native build does with each answer of /api/app-status.
 * The plugin, the platform and the network are replaced; every `load()` is a fresh launch of the app
 * (the module state is gone, the storage stays).
 * `openspec/specs/app-updates` and `openspec/changes/archive/2026-10-28-add-required-js-update`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateAvailability, type AppStatusApiResponse } from '@ryadom/contracts/api/app-status'
import { AppHeader } from '@ryadom/contracts/api/headers'

const updater = vi.hoisted(() => ({
  list: vi.fn(),
  download: vi.fn(),
  next: vi.fn(),
  set: vi.fn(),
  notifyAppReady: vi.fn(),
}))
const device = vi.hoisted(() => ({ versionCode: 12 as number | null }))
const analytics = vi.hoisted(() => ({ report: vi.fn() }))

vi.mock('@capgo/capacitor-updater', () => ({ CapacitorUpdater: updater }))
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: () => {} }) } }))
vi.mock('../src/client/lib/platform', () => ({
  isNative: () => true,
  isIosNative: () => false,
  isWebBuild: () => false,
}))
vi.mock('../src/client/lib/device', () => ({
  getVersionInfo: async () => ({ versionName: '0.1.0', versionCode: device.versionCode }),
}))
vi.mock('../src/client/lib/env', () => ({ getApiBase: () => 'https://api.test' }))
vi.mock('../src/client/lib/native', () => ({ onNetworkChange: () => () => {} }))
vi.mock('../src/client/lib/analytics', () => ({ reportAppUpdate: analytics.report }))
vi.mock('../src/client/lib/service-worker', () => ({ initServiceWorker: () => () => {} }))

const BUNDLE = 'https://api.test/api/ota/ryadom-prod-0.1.0.42.zip'
const CHECKSUM = 'a'.repeat(64)
const LAST_VERSION_CODE_KEY = 'ryadom.update.lastVersionCode'
const NEXT_BUNDLE_KEY = 'ryadom.update.nextJsVersion'
const BANNER_DISMISSED_KEY = 'ryadom.update.dismissedVersionCode'

let storage: Map<string, string>
let states: Array<{ kind: string }>
let requests: URL[]
let reply: Partial<AppStatusApiResponse> | 'broken'

function status(overrides: Partial<AppStatusApiResponse>): Partial<AppStatusApiResponse> {
  return {
    runtimeUpdate: UpdateAvailability.NotAvailable,
    latestVersionCode: 12,
    storeUrl: 'https://store.test/ryadom',
    downloadUrl: null,
    jsUpdate: UpdateAvailability.NotAvailable,
    jsVersion: '0.1.0.42',
    jsBundleUrl: null,
    jsBundleChecksum: null,
    ...overrides,
  }
}

const offered = { jsBundleUrl: BUNDLE, jsBundleChecksum: CHECKSUM }

beforeEach(() => {
  storage = new Map()
  states = []
  requests = []
  reply = status({})
  device.versionCode = 12
  vi.stubEnv('VITE_FLAVOR', 'prod')
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  vi.stubGlobal('fetch', async (input: string) => {
    requests.push(new URL(input))
    const body =
      reply === 'broken'
        ? { status: true, result: { runtimeUpdate: 'soon' } }
        : { status: true, result: reply }
    return { ok: true, status: 200, json: async () => body }
  })
  updater.list.mockResolvedValue({ bundles: [] })
  updater.download.mockImplementation(async ({ version }: { version: string }) => ({
    id: `id-${version}`,
    version,
  }))
  updater.next.mockResolvedValue(undefined)
  updater.set.mockResolvedValue(undefined)
  updater.notifyAppReady.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

/** A fresh launch of the app: runs the launch check and waits until it has settled. */
async function load() {
  const win = new EventTarget()
  vi.stubGlobal('window', win)
  vi.resetModules()
  const mod = await import('../src/client/lib/app-update')
  win.addEventListener(mod.APP_UPDATE_EVENT, (event) =>
    states.push((event as CustomEvent<{ kind: string }>).detail),
  )
  const before = requests.length
  mod.initAppUpdates()
  await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before))
  // The check goes on after the response: parsing, the plugin calls and the UI events are all async.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return mod
}

const kinds = () => states.map((state) => state.kind)

describe('версии в запросах', () => {
  it('боевая сборка сообщает версию своего JS — ту же, что у пакета в манифесте', async () => {
    const mod = await load()
    expect(requests[0].searchParams.get('platform')).toBe('android')
    expect(requests[0].searchParams.get('version_code')).toBe('12')
    expect(requests[0].searchParams.get('js_version')).toBe(__JS_VERSION__)
    expect(await mod.getVersionHeaders()).toEqual({
      [AppHeader.Platform]: 'android',
      [AppHeader.AppVersion]: '12',
      [AppHeader.JsVersion]: __JS_VERSION__,
    })
    expect(updater.notifyAppReady).toHaveBeenCalled()
  })

  it('dev-сборка не сообщает версию JS', async () => {
    vi.stubEnv('VITE_FLAVOR', 'dev')
    const mod = await load()
    expect(requests[0].searchParams.has('js_version')).toBe(false)
    expect(await mod.getVersionHeaders()).not.toHaveProperty(AppHeader.JsVersion)
  })

  it('без номера сборки нет ни заголовков, ни проверки', async () => {
    device.versionCode = null
    vi.stubGlobal('window', new EventTarget())
    vi.resetModules()
    const mod = await import('../src/client/lib/app-update')
    mod.initAppUpdates()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests).toHaveLength(0)
    expect(await mod.getVersionHeaders()).toEqual({})
  })
})

describe('нативная сборка', () => {
  it('жёстко: ниже минимума — блокирующий экран, JS не трогается', async () => {
    reply = status({
      runtimeUpdate: UpdateAvailability.Required,
      jsUpdate: UpdateAvailability.Required,
      ...offered,
    })
    await load()
    expect(states).toEqual([
      { kind: 'store-required', storeUrl: 'https://store.test/ryadom', downloadUrl: null },
    ])
    expect(updater.download).not.toHaveBeenCalled()
    expect(updater.set).not.toHaveBeenCalled()
  })

  it('мягко: баннер, закрытие помнится для этого номера, более новый показывается снова', async () => {
    reply = status({ runtimeUpdate: UpdateAvailability.Available, latestVersionCode: 13 })
    const mod = await load()
    expect(states).toEqual([
      { kind: 'store-banner', storeUrl: 'https://store.test/ryadom', downloadUrl: null, versionCode: 13 },
    ])

    mod.dismissStoreBanner(13)
    expect(storage.get(BANNER_DISMISSED_KEY)).toBe('13')
    states = []
    await load()
    expect(kinds()).not.toContain('store-banner')

    reply = status({ runtimeUpdate: UpdateAvailability.Available, latestVersionCode: 14 })
    states = []
    await load()
    expect(kinds()).toEqual(['store-banner'])
  })

  it('обновления нет — баннер убирается', async () => {
    await load()
    expect(kinds()).toEqual(['none'])
  })
})

describe('JS по воздуху', () => {
  it('мягко: пакет скачивается тихо, с контрольной суммой, и назначается на следующий запуск', async () => {
    reply = status({ jsUpdate: UpdateAvailability.Available, ...offered })
    await load()
    expect(updater.download).toHaveBeenCalledWith({ url: BUNDLE, version: '0.1.0.42', checksum: CHECKSUM })
    expect(updater.next).toHaveBeenCalledWith({ id: 'id-0.1.0.42' })
    expect(updater.set).not.toHaveBeenCalled()
    expect(kinds()).not.toContain('js-updating')
    expect(storage.get(NEXT_BUNDLE_KEY)).toBe('0.1.0.42')

    // The next launch does not download the same version again.
    updater.download.mockClear()
    await load()
    expect(updater.download).not.toHaveBeenCalled()
  })

  it('жёстко: экран «Обновляемся», загрузка и немедленное применение', async () => {
    reply = status({ jsUpdate: UpdateAvailability.Required, ...offered })
    await load()
    expect(kinds()).toEqual(['js-updating'])
    expect(updater.download).toHaveBeenCalledWith({ url: BUNDLE, version: '0.1.0.42', checksum: CHECKSUM })
    expect(updater.set).toHaveBeenCalledWith({ id: 'id-0.1.0.42' })
  })

  it('жёстко, а пакет уже скачан: применяется без новой загрузки (откат на прежний пакет)', async () => {
    updater.list.mockResolvedValue({ bundles: [{ id: 'old', version: '0.1.0.42' }] })
    reply = status({ jsUpdate: UpdateAvailability.Required, ...offered })
    await load()
    expect(updater.download).not.toHaveBeenCalled()
    expect(updater.set).toHaveBeenCalledWith({ id: 'old' })
  })

  it('жёстко, а загрузка не удалась: экран убирается, человек не заблокирован', async () => {
    updater.download.mockRejectedValue(new Error('checksum failed'))
    reply = status({ jsUpdate: UpdateAvailability.Required, ...offered })
    await load()
    expect(kinds()).toEqual(['js-updating', 'none'])
    expect(updater.set).not.toHaveBeenCalled()
  })

  it('обязательное обновление без адреса пакета игнорируется', async () => {
    reply = status({ jsUpdate: UpdateAvailability.Required })
    await load()
    expect(kinds()).toEqual(['none'])
    expect(updater.download).not.toHaveBeenCalled()
  })

  it('первый запуск после обновления из магазина: доступный пакет применяется сразу', async () => {
    storage.set(LAST_VERSION_CODE_KEY, '11')
    reply = status({ jsUpdate: UpdateAvailability.Available, ...offered })
    await load()
    expect(kinds()).toEqual(['js-updating'])
    expect(updater.set).toHaveBeenCalledWith({ id: 'id-0.1.0.42' })
    expect(storage.get(LAST_VERSION_CODE_KEY)).toBe('12')
  })

  it('чистая установка: доступный пакет — тихо', async () => {
    reply = status({ jsUpdate: UpdateAvailability.Available, ...offered })
    await load()
    expect(updater.set).not.toHaveBeenCalled()
    expect(updater.next).toHaveBeenCalled()
  })

  it('пакет, назначенный на запуск, применился: это замечено, отметка снята', async () => {
    storage.set(NEXT_BUNDLE_KEY, __JS_VERSION__)
    await load()
    expect(analytics.report).toHaveBeenCalledWith('ota', 'applied', __JS_VERSION__)
    expect(storage.has(NEXT_BUNDLE_KEY)).toBe(false)
  })
})

describe('сбои проверки', () => {
  it('неизвестное значение в ответе: ни экрана, ни баннера, ошибка в консоли', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    reply = 'broken'
    await load()
    expect(states).toEqual([])
    expect(error).toHaveBeenCalledWith(
      'app-status check broken',
      expect.objectContaining({ reason: 'shape' }),
    )
    error.mockRestore()
  })
})
