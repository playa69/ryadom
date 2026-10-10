import type { PostHog } from 'posthog-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import {
  buildSdkConfig,
  captureError,
  NEVER_CAPTURE,
  getFeatureFlag,
  identify,
  isAnalyticsOptedOut,
  loadAnalyticsConfig,
  reconcileOptOut,
  resetAnalyticsForTests,
  resetIdentity,
  setAnalyticsOptOut,
  startAnalytics,
  track,
  trackAnonymous,
  trackPageview,
} from '../src/browser'
import { AnalyticsEvent } from '../src/events'

const CONFIG: AnalyticsConfigApiResponse = {
  enabled: true,
  key: 'phc_test',
  uiHost: 'https://eu.posthog.com',
  environment: 'staging',
  features: {
    sessionReplay: false,
    clickCapture: false,
    heatmapCapture: false,
    errorTracking: true,
    webVitals: true,
    featureFlags: true,
    surveys: false,
    autocapture: false,
    heatmaps: false,
  },
}

function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ status: true, result }), { status: 200 })
}

function fakePostHog() {
  const posthog = {
    init: vi.fn((_key: string, _config: Record<string, unknown>) => {}),
    register: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    captureException: vi.fn(),
    opt_out_capturing: vi.fn(),
    opt_in_capturing: vi.fn(),
    onFeatureFlags: vi.fn(),
    getFeatureFlag: vi.fn(() => 'variant' as string | boolean | undefined),
    isFeatureEnabled: vi.fn(() => true as boolean | undefined),
  }
  return posthog
}

function start(config: AnalyticsConfigApiResponse | null, posthog = fakePostHog()) {
  const fetchStub = vi.fn(async () => (config ? envelope(config) : new Response('{}', { status: 500 })))
  const loadSdk = vi.fn(async () => posthog as unknown as PostHog)
  const started = startAnalytics({
    apiBase: 'https://api.test',
    platform: 'web',
    appVersion: '1.2.3',
    fetch: fetchStub as unknown as typeof fetch,
    loadSdk,
  })
  return { posthog, fetchStub, loadSdk, started }
}

beforeEach(() => {
  resetAnalyticsForTests()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/home' })
})

describe('loadAnalyticsConfig', () => {
  it('разворачивает конверт API', async () => {
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => envelope(CONFIG))
    expect(await loadAnalyticsConfig('https://api.test', fetchStub as unknown as typeof fetch)).toEqual(CONFIG)
    expect(fetchStub.mock.calls[0]![0]).toBe('https://api.test/api/analytics/config')
  })

  it('любая неудача — null, а не исключение', async () => {
    expect(await loadAnalyticsConfig('', (async () => new Response('', { status: 503 })) as typeof fetch)).toBeNull()
    expect(await loadAnalyticsConfig('', (async () => Promise.reject(new Error('offline'))) as typeof fetch)).toBeNull()
    expect(
      await loadAnalyticsConfig('', (async () => new Response('{"status":false,"errorCode":"X","errorMessage":"m"}')) as typeof fetch),
    ).toBeNull()
  })
})

describe('startAnalytics', () => {
  it('если сервер не включил аналитику, SDK даже не загружается', async () => {
    const { loadSdk, started } = start({ ...CONFIG, enabled: false, key: null })
    expect(await started).toBe(false)
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('если конфиг не получен, аналитика остаётся выключенной', async () => {
    const { loadSdk, started } = start(null)
    expect(await started).toBe(false)
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('инициализирует SDK через прокси и регистрирует платформу и окружение', async () => {
    const { posthog, started } = start(CONFIG)
    expect(await started).toBe(true)
    expect(posthog.init).toHaveBeenCalledTimes(1)
    const [key, options] = posthog.init.mock.calls[0]! as unknown as [string, Record<string, unknown>]
    expect(key).toBe('phc_test')
    expect(options.api_host).toBe('https://api.test/api/ingest')
    expect(posthog.register).toHaveBeenCalledWith({
      app_platform: 'web',
      app_version: '1.2.3',
      app_env: 'staging',
      $geoip_disable: true,
    })
  })

  it('вызовы до готовности ждут в очереди и уходят по порядку', async () => {
    const { posthog, started } = start(CONFIG)
    track(AnalyticsEvent.CtaClicked, { cta: 'register', placement: 'hero' })
    identify('user-1', { account_kind: 'email' })
    track(AnalyticsEvent.OfflineShown)
    expect(posthog.capture).not.toHaveBeenCalled()
    await started
    expect(posthog.capture.mock.calls.map((call) => call[0])).toEqual(['cta_clicked', 'offline_shown'])
    expect(posthog.identify).toHaveBeenCalledWith('user-1', { account_kind: 'email' })
  })

  it('если аналитика выключена, очередь сбрасывается и вызовы больше ничего не копят', async () => {
    const { posthog, started } = start({ ...CONFIG, enabled: false, key: null })
    track(AnalyticsEvent.OfflineShown)
    await started
    track(AnalyticsEvent.OfflineShown)
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('повторный запуск возвращает тот же результат и не инициализирует SDK второй раз', async () => {
    const first = start(CONFIG)
    const second = startAnalytics({ apiBase: 'https://api.test', platform: 'web' })
    await first.started
    expect(await second).toBe(true)
    expect(first.posthog.init).toHaveBeenCalledTimes(1)
  })

  it('сбой загрузки SDK не ломает приложение', async () => {
    const started = startAnalytics({
      apiBase: '',
      platform: 'web',
      fetch: (async () => envelope(CONFIG)) as typeof fetch,
      loadSdk: async () => {
        throw new Error('chunk failed')
      },
    })
    expect(await started).toBe(false)
    expect(() => track(AnalyticsEvent.OfflineShown)).not.toThrow()
  })
})

describe('отправка', () => {
  it('свойства событий очищаются', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    track(AnalyticsEvent.DialogMessageSent, { input: 'text', size: 'short', text: 'секрет' } as never)
    expect(posthog.capture).toHaveBeenCalledWith('dialog_message_sent', { input: 'text', size: 'short' })
  })

  it('просмотр экрана отправляется по маршруту, без идентификаторов и запроса', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    trackPageview('/dialog/3f2a1c9e-5b7d-4e1a-9c3d-0a1b2c3d4e5f?x=1')
    expect(posthog.capture).toHaveBeenCalledWith('$pageview', {
      $current_url: 'https://app.test/dialog/:id',
      screen: '/dialog/:id',
    })
  })

  it('без пути берётся текущий', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    trackPageview()
    expect(posthog.capture).toHaveBeenCalledWith('$pageview', { $current_url: 'https://app.test/home', screen: '/home' })
  })

  it('выход сбрасывает личность, ошибка уходит как исключение', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    resetIdentity()
    captureError(new Error('boom'), { where: 'dialog', email: 'a@b.co' })
    expect(posthog.reset).toHaveBeenCalled()
    expect(posthog.captureException).toHaveBeenCalledWith(expect.any(Error), { where: 'dialog' })
  })

  it('сбой SDK внутри вызова не выходит наружу', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    posthog.capture.mockImplementation(() => {
      throw new Error('sdk')
    })
    expect(() => track(AnalyticsEvent.OfflineShown)).not.toThrow()
  })
})

describe('анонимные события', () => {
  function stubAnonymousFetch() {
    const sent: { url: string; body: Record<string, unknown>; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, init })
        return new Response('{"status":"Ok"}')
      }),
    )
    return sent
  }

  it('уходят мимо SDK: случайный id на каждое событие, без профиля, свойства очищены', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    const sent = stubAnonymousFetch()

    trackAnonymous(AnalyticsEvent.SosOpened, { source: 'header' })
    trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: 'Телефон доверия', email: 'a@b.co' } as never)

    expect(posthog.capture).not.toHaveBeenCalled()
    expect(sent).toHaveLength(2)
    expect(sent[0]!.url).toBe('https://api.test/api/ingest/e/?ip=0')
    expect(sent[0]!.body).toMatchObject({
      api_key: 'phc_test',
      event: 'sos_opened',
      properties: { source: 'header', app_platform: 'web', app_env: 'staging', $process_person_profile: false },
    })
    expect(sent[1]!.body.properties).not.toHaveProperty('email')
    // A new id every time: two taps by one person cannot be joined into a history.
    expect(sent[0]!.body.distinct_id).not.toBe(sent[1]!.body.distinct_id)
    // Dated to the hour: the minute of the tap cannot be set beside the same person's other events.
    expect(String(sent[0]!.body.timestamp)).toMatch(/T\d{2}:00:00\.000Z$/)
    expect(sent[0]!.init.credentials).toBe('omit')
  })

  it('не уходят, если аналитика выключена, человек отказался или включён Do Not Track', async () => {
    const off = start({ ...CONFIG, enabled: false, key: null })
    await off.started
    const sent = stubAnonymousFetch()
    trackAnonymous(AnalyticsEvent.SosOpened, { source: 'header' })
    expect(sent).toHaveLength(0)

    resetAnalyticsForTests()
    const on = start(CONFIG)
    await on.started
    setAnalyticsOptOut(true)
    trackAnonymous(AnalyticsEvent.SosOpened, { source: 'header' })
    expect(sent).toHaveLength(0)

    setAnalyticsOptOut(false)
    vi.stubGlobal('navigator', { doNotTrack: '1' })
    trackAnonymous(AnalyticsEvent.SosOpened, { source: 'header' })
    expect(sent).toHaveLength(0)
  })
})

describe('флаги функций', () => {
  it('до готовности — undefined, потом значение SDK', async () => {
    const { started } = start(CONFIG)
    expect(getFeatureFlag('beta')).toBeUndefined()
    await started
    expect(getFeatureFlag('beta')).toBe('variant')
  })
})

describe('отказ от аналитики', () => {
  it('запоминается на устройстве и переключает SDK', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    expect(isAnalyticsOptedOut()).toBe(false)
    setAnalyticsOptOut(true)
    expect(isAnalyticsOptedOut()).toBe(true)
    expect(posthog.opt_out_capturing).toHaveBeenCalled()
    setAnalyticsOptOut(false)
    expect(isAnalyticsOptedOut()).toBe(false)
    expect(posthog.opt_in_capturing).toHaveBeenCalled()
  })

  it('при запуске уже отказавшегося SDK стартует с выключенной отправкой', async () => {
    setAnalyticsOptOut(true)
    const { posthog, started } = start(CONFIG)
    await started
    const options = posthog.init.mock.calls[0]![1] as unknown as { opt_out_capturing_by_default: boolean }
    expect(options.opt_out_capturing_by_default).toBe(true)
  })
})

describe('согласование отказа устройства и аккаунта', () => {
  it('отказался на другом устройстве: это устройство тоже замолкает', async () => {
    const tellServer = vi.fn(async () => {})
    await reconcileOptOut(true, tellServer)
    expect(isAnalyticsOptedOut()).toBe(true)
    expect(tellServer).not.toHaveBeenCalled()
  })

  it('отказался здесь до входа: аккаунту сообщают', async () => {
    setAnalyticsOptOut(true)
    const tellServer = vi.fn(async () => {})
    await reconcileOptOut(false, tellServer)
    expect(tellServer).toHaveBeenCalledWith(true)
    expect(isAnalyticsOptedOut()).toBe(true)
  })

  it('оба согласны или оба за аналитику: ничего не меняется', async () => {
    const tellServer = vi.fn(async () => {})
    await reconcileOptOut(false, tellServer)
    expect(isAnalyticsOptedOut()).toBe(false)
    setAnalyticsOptOut(true)
    await reconcileOptOut(true, tellServer)
    expect(tellServer).not.toHaveBeenCalled()
  })

  it('включить аналитику обратно может только явное действие: согласование этого не делает', async () => {
    setAnalyticsOptOut(true)
    await reconcileOptOut(false, async () => {})
    expect(isAnalyticsOptedOut()).toBe(true)
  })

  it('сбой сообщения аккаунту не выходит наружу', async () => {
    setAnalyticsOptOut(true)
    await expect(reconcileOptOut(false, async () => Promise.reject(new Error('offline')))).resolves.toBeUndefined()
  })
})

describe('buildSdkConfig: приватность по умолчанию', () => {
  const config = buildSdkConfig(CONFIG, 'https://api.test')

  it('без cookie, без автосбора, без записи экрана', () => {
    expect(config.persistence).toBe('localStorage')
    expect(config.autocapture).toBe(false)
    expect(config.capture_dead_clicks).toBe(false)
    expect(config.capture_heatmaps).toBe(false)
    expect(config.disable_session_recording).toBe(true)
    expect(config.person_profiles).toBe('identified_only')
    expect(config.respect_dnt).toBe(true)
    expect(config.capture_pageview).toBe(false)
    expect(config.ip).toBe(false)
  })

  it('без захвата кликов нет ни кликов, ни мёртвых, ни яростных', () => {
    expect(config.autocapture).toBe(false)
    expect(config.capture_dead_clicks).toBe(false)
    expect(config.rageclick).toBe(false)
  })

  it('клики не снимаются на метке, в порталах и в окнах Framework7: там тоже действия человека', () => {
    for (const selector of ['.ph-no-capture', '[role="dialog"]', '[role="alertdialog"]', '.dialog', '.sheet-modal', '.popup']) {
      expect(NEVER_CAPTURE).toContain(selector)
    }
  })

  it('уход со страницы отправляется всегда, текст элементов маскируется всегда', () => {
    expect(config.capture_pageleave).toBe(true)
    expect(config.mask_all_text).toBe(true)
  })

  it('веб-метрики без атрибуции: она называет элемент и ресурс страницы', () => {
    expect(config.capture_performance).toEqual({ web_vitals: true, web_vitals_attribution: false })
  })

  it('запись экрана, если её включили на сервере, скрывает весь текст и все поля', () => {
    const replay = buildSdkConfig({ ...CONFIG, features: { ...CONFIG.features, sessionReplay: true } }, '')
    expect(replay.disable_session_recording).toBe(false)
    expect(replay.session_recording).toMatchObject({ maskAllInputs: true, maskTextSelector: '*' })
  })

  it('каждая возможность включается своим переключателем', () => {
    const all = buildSdkConfig(
      {
        ...CONFIG,
        features: {
          ...CONFIG.features,
          sessionReplay: true,
          clickCapture: true,
          heatmapCapture: true,
          errorTracking: false,
          webVitals: false,
          featureFlags: false,
        },
      },
      '',
    )
    expect(all.autocapture).toEqual({
      dom_event_allowlist: ['click'],
      capture_copied_text: false,
      css_selector_ignorelist: NEVER_CAPTURE,
    })
    expect(all.capture_dead_clicks).toEqual({ css_selector_ignorelist: NEVER_CAPTURE })
    expect(all.rageclick).toEqual({ css_selector_ignorelist: NEVER_CAPTURE })
    expect(all.capture_heatmaps).toBe(true)
    expect(all.capture_exceptions).toBe(false)
    expect(all.capture_performance).toBe(false)
    expect(all.advanced_disable_flags).toBe(true)
  })

  it('имена, которые читают старые клиенты, ничего не включают в новом', () => {
    const old = buildSdkConfig(
      { ...CONFIG, features: { ...CONFIG.features, surveys: false, autocapture: false, heatmaps: false } },
      '',
    )
    expect(old.autocapture).toBe(false)
    expect(old.capture_heatmaps).toBe(false)
  })

  it('ответ старого API без новых полей не отдаёт решение настройкам проекта PostHog: всё выключено', () => {
    const old = buildSdkConfig({ ...CONFIG, features: {} as never }, '')
    expect(old.autocapture).toBe(false)
    expect(old.capture_dead_clicks).toBe(false)
    expect(old.capture_heatmaps).toBe(false)
    expect(old.capture_exceptions).toBe(false)
    expect(old.capture_performance).toBe(false)
    expect(old.disable_session_recording).toBe(true)
    expect(old.advanced_disable_flags).toBe(true)
  })

  it('рекламные метки SDK сам заменяет на <masked>', () => {
    expect(config.mask_personal_data_properties).toBe(true)
  })

  it('опросов в продукте нет: SDK их не грузит, что бы ни пришло с сервера', () => {
    const everything = buildSdkConfig(
      {
        ...CONFIG,
        features: { ...CONFIG.features, sessionReplay: true, clickCapture: true, heatmapCapture: true },
      },
      '',
    )
    expect(config.disable_surveys).toBe(true)
    expect(everything.disable_surveys).toBe(true)
    expect(everything).not.toHaveProperty('prepare_external_dependency_stylesheet')
  })

  it('SDK не определяет место по адресу сервера: геолокация выключена для всех событий', async () => {
    const { posthog, started } = start(CONFIG)
    await started
    expect(posthog.register).toHaveBeenCalledWith(expect.objectContaining({ $geoip_disable: true }))
  })

  it('before_send чистит адреса событий', () => {
    const beforeSend = config.before_send as (event: unknown) => { properties: Record<string, string> }
    const event = beforeSend({ properties: { $current_url: 'https://app.test/reset-password?token=abc' } })
    expect(event.properties.$current_url).toBe('https://app.test/reset-password')
  })
})
