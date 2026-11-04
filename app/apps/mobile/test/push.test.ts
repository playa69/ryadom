/**
 * Notifications on this phone, the web part (`openspec/changes/add-push-notifications`, «Включение уведомлений на
 * телефоне», «Уведомления только открытым сессиям», «Касание уведомления»). The plugin, the platform and the API are
 * replaced; each test loads the module afresh, the storage stays as the test leaves it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: never) => void

const env = vi.hoisted(() => ({ android: true, plugin: true }))
const plugin = vi.hoisted(() => ({
  permission: 'prompt' as 'granted' | 'denied' | 'prompt',
  answer: 'granted' as 'granted' | 'denied',
  tokenError: null as null | { code: string },
  requested: 0,
  deleted: 0,
  listeners: new Map<string, Listener>(),
}))
const api = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))
const nav = vi.hoisted(() => ({ opened: [] as string[] }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => env.plugin },
  registerPlugin: () => ({
    checkPermission: async () => ({ receive: plugin.permission }),
    requestPermission: async () => {
      plugin.requested += 1
      plugin.permission = plugin.answer
      return { receive: plugin.permission }
    },
    getToken: async () => {
      if (plugin.tokenError) throw plugin.tokenError
      return { token: 'rustore-token', projectId: 'testProject', appId: 'ru.ryadom.companion.dev' }
    },
    deleteToken: async () => {
      plugin.deleted += 1
    },
    openSettings: async () => {},
    addListener: async (name: string, listener: Listener) => {
      plugin.listeners.set(name, listener)
      return { remove: async () => plugin.listeners.delete(name) }
    },
  }),
}))
vi.mock('../src/client/lib/platform', () => ({ isAndroid: () => env.android }))
vi.mock('../src/client/lib/api', () => ({ subscribePush: api.subscribe, unsubscribePush: api.unsubscribe }))
vi.mock('../src/client/lib/nav', async () => {
  const actual = await vi.importActual<typeof import('../src/client/lib/nav')>('../src/client/lib/nav')
  return { isAppRoute: actual.isAppRoute, openRoute: (route: string) => nav.opened.push(route) }
})

const load = async () => {
  vi.resetModules()
  return import('../src/client/lib/push')
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  Object.assign(env, { android: true, plugin: true })
  Object.assign(plugin, {
    permission: 'prompt',
    answer: 'granted',
    tokenError: null,
    requested: 0,
    deleted: 0,
  })
  plugin.listeners.clear()
  nav.opened = []
  api.subscribe.mockReset().mockResolvedValue({ ok: true, data: { subscriptionId: 'sub-1' } })
  api.unsubscribe.mockReset().mockResolvedValue({ ok: true, data: undefined })
})

describe('включение уведомлений на телефоне', () => {
  it('без плагина в сборке и не на Android переключателя нет, плагин не вызывается', async () => {
    env.plugin = false
    expect((await load()).pushSupported()).toBe(false)
    env.plugin = true
    env.android = false
    const push = await load()
    expect(push.pushSupported()).toBe(false)
    expect(await push.enablePush()).toBe('unavailable')
    expect(plugin.requested).toBe(0)
    expect(api.subscribe).not.toHaveBeenCalled()
  })

  it('выключено, пока человек не включил; системный запрос — только при включении', async () => {
    const push = await load()
    expect(push.pushEnabled()).toBe(false)
    expect(plugin.requested).toBe(0)

    expect(await push.enablePush()).toBe('enabled')
    expect(plugin.requested).toBe(1)
    expect(api.subscribe).toHaveBeenCalledWith({
      channel: 'rustore',
      token: 'rustore-token',
      projectId: 'testProject',
      appId: 'ru.ryadom.companion.dev',
    })
    expect(push.pushEnabled()).toBe(true)
  })

  it('отказ в системе — выключено, на сервер ничего не ушло', async () => {
    plugin.answer = 'denied'
    const push = await load()
    expect(await push.enablePush()).toBe('denied')
    expect(push.pushEnabled()).toBe(false)
    expect(api.subscribe).not.toHaveBeenCalled()
  })

  it('нет RuStore на телефоне — «unavailable», выключено', async () => {
    plugin.permission = 'granted'
    plugin.tokenError = { code: 'UNAVAILABLE' }
    const push = await load()
    expect(await push.enablePush()).toBe('unavailable')
    expect(push.pushEnabled()).toBe(false)
  })

  it('выключение снимает подписку и удаляет токен', async () => {
    const push = await load()
    await push.enablePush()
    await push.disablePush()
    expect(api.unsubscribe).toHaveBeenCalledWith('sub-1')
    expect(plugin.deleted).toBe(1)
    expect(push.pushEnabled()).toBe(false)
  })

  it('сервер молчит при выключении — устройство всё равно выключено', async () => {
    vi.useFakeTimers()
    try {
      const push = await load()
      await push.enablePush()
      api.unsubscribe.mockReturnValue(new Promise(() => {}))
      const done = push.disablePush()
      await vi.advanceTimersByTimeAsync(3_000)
      await done
      expect(push.pushEnabled()).toBe(false)
      expect(plugin.deleted).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('повторная подписка и касание', () => {
  it('включённое устройство подписывается снова при запуске и с новым токеном', async () => {
    plugin.permission = 'granted'
    await (await load()).enablePush()
    api.subscribe.mockClear()

    const push = await load()
    const stop = push.initPush()
    await flush()
    expect(api.subscribe).toHaveBeenCalledTimes(1)

    plugin.listeners.get('tokenChanged')?.({ token: 'new-token' } as never)
    await flush()
    expect(api.subscribe).toHaveBeenCalledTimes(2)
    stop()
  })

  it('разрешение отозвано в настройках — не подписывается, но остаётся включённым до решения человека', async () => {
    plugin.permission = 'granted'
    await (await load()).enablePush()
    api.subscribe.mockClear()
    plugin.permission = 'denied'

    const push = await load()
    push.initPush()
    await flush()
    expect(api.subscribe).not.toHaveBeenCalled()
    expect(push.pushEnabled()).toBe(true)
  })

  it('выключенное устройство при запуске не подписывается', async () => {
    const push = await load()
    push.initPush()
    await flush()
    expect(api.subscribe).not.toHaveBeenCalled()
  })

  it('касание со ссылкой на экран приложения открывает его, чужую ссылку — нет', async () => {
    const push = await load()
    push.initPush()
    await flush()
    const opened = plugin.listeners.get('notificationOpened')!
    opened({ data: { link: '/diary/' } } as never)
    opened({ data: { link: 'https://example.com/' } } as never)
    opened({ data: {} } as never)
    expect(nav.opened).toEqual(['/diary/'])
  })

  it('сессия кончилась без устройства — локально выключено, токен удалён, на сервер не ходим', async () => {
    const push = await load()
    await push.enablePush()
    push.forgetPush()
    expect(push.pushEnabled()).toBe(false)
    expect(api.unsubscribe).not.toHaveBeenCalled()
    await flush()
    expect(plugin.deleted).toBe(1)
  })
})
