import type { PostHog } from 'posthog-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsConfigApiResponse, MetrikaConfigApiResponse } from '@ryadom/contracts/api/analytics'
import { resetAnalyticsForTests, setAnalyticsOptOut, startAnalytics, trackPageview } from '../src/browser'
import { MetrikaGoal, type AnalyticsPlatform } from '../src/events'
import {
  metrikaGoal,
  metrikaHit,
  metrikaWillReport,
  reportReplyCount,
  resetMetrikaForTests,
  setMetrikaSuppressed,
  startMetrika,
} from '../src/metrika'

const COUNTER = 114043323
const METRIKA: MetrikaConfigApiResponse = { counterId: COUNTER, webvisor: true, clickmap: true }

type YmCall = [number, string, ...unknown[]]
let ym: ReturnType<typeof vi.fn<(...args: YmCall) => void>>

function calls(method: string): YmCall[] {
  return ym.mock.calls.filter((call) => call[1] === method)
}

function begin(options: {
  config?: MetrikaConfigApiResponse | undefined
  platform?: AnalyticsPlatform
  suppressed?: boolean
}) {
  const loadTag = vi.fn()
  startMetrika({
    config: 'config' in options ? options.config : METRIKA,
    platform: options.platform ?? 'web',
    appVersion: '1.2.3',
    suppressed: options.suppressed ?? false,
    loadTag,
  })
  return { loadTag }
}

beforeEach(() => {
  resetAnalyticsForTests()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/home', href: 'https://app.test/home' })
  vi.stubGlobal('document', { referrer: '' })
  vi.stubGlobal('navigator', { doNotTrack: null })
  ym = vi.fn()
  vi.stubGlobal('ym', ym)
})

describe('каталог целей', () => {
  it('идентификаторы совпадают с теми, что заведены в кабинете счётчика (цель «Переход в продукт» — по адресам, её здесь нет)', () => {
    expect(Object.values(MetrikaGoal)).toEqual(['first_reply', 'polz_3', 'dau_10'])
  })
})

describe('startMetrika', () => {
  it('без счётчика в ответе сервера тег не грузится и ничего не уходит', () => {
    const { loadTag } = begin({ config: undefined })
    metrikaHit('https://app.test/home')
    metrikaGoal(MetrikaGoal.FirstReply)
    expect(loadTag).not.toHaveBeenCalled()
    expect(ym).not.toHaveBeenCalled()
    expect(metrikaWillReport()).toBe(false)
  })

  it('со счётчиком: тег грузится, запуск с отложенным первым хитом и без слежения за ссылками', () => {
    const { loadTag } = begin({ platform: 'web' })
    expect(loadTag).toHaveBeenCalledTimes(1)
    const [id, , options] = calls('init')[0]!
    expect(id).toBe(COUNTER)
    // `defer` is what keeps the tag from reporting the raw address (checked against the real tag).
    expect(options).toMatchObject({ defer: true, trackLinks: false, accurateTrackBounce: false })
  })

  it('на лендинге запись экрана и карта кликов включаются, если окружение разрешило', () => {
    begin({ platform: 'landing' })
    expect(calls('init')[0]![2]).toMatchObject({ webvisor: true, clickmap: true })
  })

  it('на лендинге без разрешения окружения запись и карта кликов выключены', () => {
    begin({ platform: 'landing', config: { counterId: COUNTER, webvisor: false, clickmap: false } })
    expect(calls('init')[0]![2]).toMatchObject({ webvisor: false, clickmap: false })
  })

  it.each<AnalyticsPlatform>(['web', 'pwa', 'telegram', 'android', 'ios'])(
    'в приложении (%s) запись экрана и карта кликов выключены, что бы ни сказал сервер',
    (platform) => {
      begin({ platform })
      expect(calls('init')[0]![2]).toMatchObject({ webvisor: false, clickmap: false })
    },
  )

  it('вызовы до ответа сервера ждут и уходят по порядку', () => {
    metrikaHit('https://app.test/a')
    metrikaGoal(MetrikaGoal.FirstReply)
    expect(ym).not.toHaveBeenCalled()
    expect(metrikaWillReport()).toBe(true)
    begin({})
    expect(ym.mock.calls.map((call) => call[1])).toEqual(['init', 'hit', 'reachGoal'])
  })

  it('вызовы до ответа сервера пропадают, если Метрика выключена', () => {
    metrikaHit('https://app.test/a')
    begin({ config: undefined })
    expect(ym).not.toHaveBeenCalled()
  })

  it('второй запуск за страницу игнорируется', () => {
    const first = begin({})
    const second = begin({})
    expect(first.loadTag).toHaveBeenCalledTimes(1)
    expect(second.loadTag).not.toHaveBeenCalled()
    expect(calls('init')).toHaveLength(1)
  })

  it('сбой загрузки тега не бросает исключение', () => {
    const loadTag = vi.fn(() => {
      throw new Error('blocked')
    })
    expect(() => startMetrika({ config: METRIKA, platform: 'web', suppressed: false, loadTag })).not.toThrow()
    expect(() => metrikaHit('https://app.test/a')).not.toThrow()
  })
})

describe('metrikaHit', () => {
  it('хит несёт переданный адрес, название-путь и параметры визита: платформу и версию', () => {
    begin({ platform: 'telegram' })
    metrikaHit('https://app.test/pwa/home/')
    expect(calls('hit')[0]).toEqual([
      COUNTER,
      'hit',
      'https://app.test/pwa/home/',
      { title: '/pwa/home/', params: { app_platform: 'telegram', app_version: '1.2.3' } },
    ])
  })

  it('следующий хит ссылается на прежний адрес, первый — на очищенный внешний переход', () => {
    vi.stubGlobal('document', { referrer: 'https://search.example/results?q=private+phrase#frag' })
    begin({})
    metrikaHit('https://app.test/a')
    metrikaHit('https://app.test/b')
    expect((calls('hit')[0]![3] as { referer: string }).referer).toBe('https://search.example/results')
    expect((calls('hit')[1]![3] as { referer: string }).referer).toBe('https://app.test/a')
  })
})

describe('отказ и Do Not Track', () => {
  it('при запуске с отказом тег не грузится и вызовы пропадают', () => {
    const { loadTag } = begin({ suppressed: true })
    metrikaHit('https://app.test/a')
    metrikaGoal(MetrikaGoal.FirstReply)
    expect(loadTag).not.toHaveBeenCalled()
    expect(ym).not.toHaveBeenCalled()
    expect(metrikaWillReport()).toBe(false)
  })

  it('отказ во время работы останавливает счётчик (destruct) и дальнейшие хиты не уходят', () => {
    begin({})
    metrikaHit('https://app.test/a')
    setMetrikaSuppressed(true)
    expect(calls('destruct')).toHaveLength(1)
    metrikaHit('https://app.test/b')
    metrikaGoal(MetrikaGoal.FirstReply)
    expect(calls('hit')).toHaveLength(1)
    expect(calls('reachGoal')).toHaveLength(0)
  })

  it('отказ посреди сессии и возврат: счётчик запускается заново', () => {
    const { loadTag } = begin({})
    setMetrikaSuppressed(true)
    setMetrikaSuppressed(false)
    expect(loadTag).toHaveBeenCalledTimes(2)
    expect(calls('init')).toHaveLength(2)
    metrikaHit('https://app.test/a')
    expect(calls('hit')).toHaveLength(1)
  })

  it('отказ, сказанный до запуска, ничего не делает с ещё не запущенной Метрикой', () => {
    setMetrikaSuppressed(true)
    begin({})
    expect(calls('init')).toHaveLength(1)
  })
})

// `openspec/changes/add-metrika-daily-goals`, «Цели Метрики».
describe('цели по счёту реплик аккаунта', () => {
  function goals(): unknown[] {
    return calls('reachGoal').map((call) => call[2])
  }

  it('первая реплика аккаунта — first_reply, третья за сутки — polz_3, десятая — dau_10', () => {
    begin({})
    reportReplyCount(1, true)
    expect(goals()).toEqual(['first_reply'])
    for (let today = 2; today <= 12; today += 1) reportReplyCount(today, false)
    expect(goals()).toEqual(['first_reply', 'polz_3', 'dau_10'])
  })

  it('следующие сутки начинают счёт заново, а first_reply не повторяется', () => {
    begin({})
    for (let today = 1; today <= 10; today += 1) reportReplyCount(today, false)
    expect(goals()).toEqual(['polz_3', 'dau_10'])
  })

  it('без Метрики и после отказа цели не уходят', () => {
    begin({ suppressed: true })
    reportReplyCount(3, true)
    expect(ym).not.toHaveBeenCalled()
  })
})

describe('склейка с запуском аналитики', () => {
  const NO_POSTHOG: AnalyticsConfigApiResponse = {
    enabled: false,
    key: null,
    uiHost: 'https://eu.posthog.com',
    environment: 'local',
    features: {
      sessionReplay: false,
      clickCapture: true,
      heatmapCapture: false,
      errorTracking: true,
      webVitals: true,
      featureFlags: false,
      autocapture: false,
      heatmaps: false,
    },
    metrika: METRIKA,
  }

  function launch(
    config: AnalyticsConfigApiResponse | null,
    options: { platform?: AnalyticsPlatform; pageBase?: string } = {},
  ) {
    const fetchStub = vi.fn(async () =>
      config
        ? new Response(JSON.stringify({ status: true, result: config }), { status: 200 })
        : new Response('{}', { status: 500 }),
    )
    const loadSdk = vi.fn(async () => ({}) as unknown as PostHog)
    const loadMetrikaTag = vi.fn()
    const started = startAnalytics({
      apiBase: 'https://api.test',
      platform: options.platform ?? 'web',
      appVersion: '1.2.3',
      pageBase: options.pageBase,
      fetch: fetchStub as unknown as typeof fetch,
      loadSdk,
      loadMetrikaTag,
    })
    return { started, loadSdk, loadMetrikaTag }
  }

  it('Метрика работает без PostHog: SDK не грузится, счётчик запущен', async () => {
    const { started, loadSdk, loadMetrikaTag } = launch(NO_POSTHOG)
    expect(await started).toBe(false)
    expect(loadSdk).not.toHaveBeenCalled()
    expect(loadMetrikaTag).toHaveBeenCalledTimes(1)
    expect(calls('init')).toHaveLength(1)
  })

  it('без поля metrika в ответе Метрика не запускается', async () => {
    const { metrika: _unused, ...withoutMetrika } = NO_POSTHOG
    const { started, loadMetrikaTag } = launch(withoutMetrika)
    await started
    expect(loadMetrikaTag).not.toHaveBeenCalled()
    expect(ym).not.toHaveBeenCalled()
  })

  it('если настройки получить не удалось, Метрика не запускается', async () => {
    const { started, loadMetrikaTag } = launch(null)
    await started
    expect(loadMetrikaTag).not.toHaveBeenCalled()
  })

  it('показ экрана — хит с очищенным адресом: без query, без фрагмента, с :id', async () => {
    vi.stubGlobal('location', {
      origin: 'https://app.test',
      pathname: '/app/reset-password',
      href: 'https://app.test/app/reset-password?code=SECRET123&utm_source=mail#tgWebAppData=user%3Dsecret',
    })
    const { started } = launch(NO_POSTHOG)
    trackPageview('/reset-password')
    await started
    expect(calls('hit')[0]![2]).toBe('https://app.test/app/reset-password?utm_source=mail')
    expect(JSON.stringify(ym.mock.calls)).not.toContain('SECRET123')
    expect(JSON.stringify(ym.mock.calls)).not.toContain('tgWebAppData')
  })

  it('идентификатор разговора в адресе заменяется на :id', async () => {
    vi.stubGlobal('location', {
      origin: 'https://app.test',
      pathname: '/app/dialog/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      href: 'https://app.test/app/dialog/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    })
    const { started } = launch(NO_POSTHOG)
    trackPageview('/dialog/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')
    await started
    expect(calls('hit')[0]![2]).toBe('https://app.test/app/dialog/:id')
  })

  it('клиенты без настоящих адресов (PWA, магазины) сообщают экран под своей основой', async () => {
    const { started } = launch(NO_POSTHOG, { platform: 'android', pageBase: 'https://prod.test/android' })
    trackPageview('/diary/journal/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/')
    trackPageview('/home/')
    await started
    expect(calls('hit').map((call) => call[2])).toEqual([
      'https://prod.test/android/diary/journal/:id/',
      'https://prod.test/android/home/',
    ])
  })

  // `openspec/changes/add-metrika-daily-goals`, «Яндекс Метрика: что передаётся».
  it('переход из Директа: в хит Метрики уходят метки и yclid, а нецифровой yclid отбрасывается', async () => {
    vi.stubGlobal('location', {
      origin: 'https://app.test',
      pathname: '/',
      href: 'https://app.test/?utm_campaign=autumn_promo&yclid=123456789&gclid=abc',
    })
    const { started } = launch(NO_POSTHOG, { platform: 'landing' })
    trackPageview()
    await started
    expect(calls('hit')[0]![2]).toBe('https://app.test/?utm_campaign=autumn_promo&yclid=123456789')

    resetAnalyticsForTests()
    ym.mockClear()
    vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/', href: 'https://app.test/?yclid=anna%40mail.ru' })
    const again = launch(NO_POSTHOG, { platform: 'landing' })
    trackPageview()
    await again.started
    expect(calls('hit')[0]![2]).toBe('https://app.test/')
  })

  it('PWA, открытая по ссылке с метками: метки идут с адресом экрана', async () => {
    vi.stubGlobal('location', {
      origin: 'https://app.test',
      pathname: '/pwa/',
      href: 'https://app.test/pwa/?utm_source=tg_ads&utm_campaign=promo#tgWebAppData=secret',
    })
    const { started } = launch(NO_POSTHOG, { platform: 'telegram', pageBase: 'https://app.test/pwa' })
    trackPageview('/home/')
    await started
    expect(calls('hit')[0]![2]).toBe('https://app.test/pwa/home/?utm_source=tg_ads&utm_campaign=promo')
  })

  it('Do Not Track: тег не загружается', async () => {
    vi.stubGlobal('navigator', { doNotTrack: '1' })
    const { started, loadMetrikaTag } = launch(NO_POSTHOG)
    await started
    expect(loadMetrikaTag).not.toHaveBeenCalled()
    expect(ym).not.toHaveBeenCalled()
  })

  it('отказ, сказанный до запуска: тег не загружается', async () => {
    setAnalyticsOptOut(true)
    const { started, loadMetrikaTag } = launch(NO_POSTHOG)
    await started
    expect(loadMetrikaTag).not.toHaveBeenCalled()
  })

  it('отказ во время работы останавливает счётчик', async () => {
    const { started } = launch(NO_POSTHOG)
    await started
    setAnalyticsOptOut(true)
    expect(calls('destruct')).toHaveLength(1)
    trackPageview('/home')
    expect(calls('hit')).toHaveLength(0)
  })
})
