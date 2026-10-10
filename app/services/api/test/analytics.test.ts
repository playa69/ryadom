/**
 * Product analytics on the server: the config the clients read at startup, the reverse proxy to
 * PostHog, and the events the routes report. Nothing here talks to PostHog: `fetch` is stubbed for the
 * proxy and the reports are recorded by a stand-in.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import { AppHeader, AppPlatform } from '@ryadom/contracts/api/headers'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { RATE_LIMITS } from '../src/lib/rate-limit'
import {
  PASSWORD,
  call,
  codeFor,
  makeApp,
  mockAgent,
  json,
  ok,
  recordingAnalytics,
  signUpAndIn,
  uniqueEmail,
  type RecordedEvent,
} from './helpers'

const POSTHOG = { POSTHOG_KEY: 'phc_test_key' }

function only(analytics: { events: RecordedEvent[] }, event: AnalyticsEvent): RecordedEvent[] {
  return analytics.events.filter((entry) => entry.event === event)
}

/** The report of a route that finishes it in the background (a lookup by email) arrives a tick later. */
async function eventually(analytics: { events: RecordedEvent[] }, event: AnalyticsEvent): Promise<RecordedEvent> {
  await vi.waitFor(() => expect(only(analytics, event)).toHaveLength(1))
  return only(analytics, event)[0]!
}

describe('GET /api/analytics/config', () => {
  it('без ключа PostHog аналитика выключена и клиенту не отдаётся ничего лишнего', async () => {
    const { app } = makeApp()
    const config = ok<AnalyticsConfigApiResponse>(await call(app, 'GET', '/api/analytics/config'))
    expect(config.enabled).toBe(false)
    expect(config.key).toBeNull()
    expect(Object.values(config.features).every((on) => on === false)).toBe(true)
  })

  it('с ключом: токен, окружение и безопасные значения по умолчанию', async () => {
    const { app } = makeApp({ env: POSTHOG })
    const config = ok<AnalyticsConfigApiResponse>(await call(app, 'GET', '/api/analytics/config'))
    expect(config).toMatchObject({
      enabled: true,
      key: 'phc_test_key',
      uiHost: 'https://eu.posthog.com',
      environment: 'local',
    })
    // The sensitive switches are off until someone turns them on; the harmless ones are on.
    expect(config.features).toEqual({
      sessionReplay: false,
      surveys: false,
      autocapture: false,
      heatmaps: false,
      errorTracking: true,
      webVitals: true,
      featureFlags: true,
    })
  })

  it('каждый переключатель включается своей переменной', async () => {
    const { app } = makeApp({
      env: {
        ...POSTHOG,
        POSTHOG_SESSION_REPLAY: 'true',
        POSTHOG_SURVEYS: '1',
        POSTHOG_AUTOCAPTURE: 'on',
        POSTHOG_HEATMAPS: 'yes',
        POSTHOG_ERROR_TRACKING: 'false',
        POSTHOG_WEB_VITALS: '0',
        POSTHOG_FEATURE_FLAGS: 'no',
      },
    })
    const { features } = ok<AnalyticsConfigApiResponse>(await call(app, 'GET', '/api/analytics/config'))
    expect(features).toEqual({
      sessionReplay: true,
      surveys: true,
      autocapture: true,
      heatmaps: true,
      errorTracking: false,
      webVitals: false,
      featureFlags: false,
    })
  })

  it('открыт без токена и без заголовков приложения, кэшируется на пять минут', async () => {
    const { app } = makeApp({ env: POSTHOG })
    const response = await app.request('/api/analytics/config')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  it('сборка ниже минимума получает 426, как на любом другом маршруте за гейтом версий', async () => {
    const { app } = makeApp({
      env: POSTHOG,
      policy: {
        android: { minVersionCode: 100, latestVersionCode: 100, downloadUrl: null },
        ios: { minVersionCode: 0, latestVersionCode: 0, downloadUrl: null },
        js: { latestVersion: null, bundleUrl: null, checksum: null },
      },
    })
    const response = await app.request('/api/analytics/config', {
      headers: { [AppHeader.Platform]: AppPlatform.Android, [AppHeader.AppVersion]: '1' },
    })
    // The route sits behind the gate like any other, so an outdated build is told to update, not served.
    expect(response.status).toBe(426)
  })
})

describe('/api/ingest: обратный прокси к PostHog', () => {
  const eventBody = 'x'.repeat(10)

  function stubPostHog(handler: (url: URL, init: RequestInit) => Response = () => json({ status: 1 })) {
    const calls: { url: URL; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        calls.push({ url, init })
        return handler(url, init)
      }),
    )
    return calls
  }

  it('при выключенной аналитике пути нет вовсе', async () => {
    const { app } = makeApp()
    const calls = stubPostHog()
    const response = await app.request('/api/ingest/e/', { method: 'POST', body: eventBody })
    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('пересылает событие в EU-хост PostHog и возвращает его ответ', async () => {
    const { app } = makeApp({ env: POSTHOG, analytics: recordingAnalytics() })
    const calls = stubPostHog()
    const response = await app.request('/api/ingest/e/?compression=gzip-js', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Cookie: 'sid=secret' },
      body: eventBody,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.origin).toBe('https://eu.i.posthog.com')
    expect(calls[0]!.url.pathname).toBe('/e/')
    expect(calls[0]!.url.searchParams.get('ip')).toBe('0')
    expect(new Headers(calls[0]!.init.headers).get('cookie')).toBeNull()
  })

  it('скрипты SDK берёт с assets-хоста', async () => {
    const { app } = makeApp({ env: POSTHOG, analytics: recordingAnalytics() })
    const calls = stubPostHog(() => new Response('/*sdk*/', { headers: { 'content-type': 'text/javascript' } }))
    const response = await app.request('/api/ingest/static/recorder.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('/*sdk*/')
    expect(calls[0]!.url.href).toBe('https://eu-assets.i.posthog.com/static/recorder.js')
  })

  it('чужие пути PostHog закрыты', async () => {
    const { app } = makeApp({ env: POSTHOG, analytics: recordingAnalytics() })
    const calls = stubPostHog()
    expect((await app.request('/api/ingest/api/projects/1/persons')).status).toBe(404)
    expect((await app.request('/api/ingest/')).status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('принимает тело больше 64 КБ (кусок записи сессии), общий лимит API на него не действует', async () => {
    const { app } = makeApp({ env: POSTHOG, analytics: recordingAnalytics() })
    stubPostHog()
    const chunk = 'x'.repeat(200 * 1024)
    const response = await app.request('/api/ingest/s/', { method: 'POST', body: chunk })
    expect(response.status).toBe(200)
  })

  it('но не больше 4 МБ', async () => {
    const { app } = makeApp({ env: POSTHOG, analytics: recordingAnalytics() })
    stubPostHog()
    const response = await app.request('/api/ingest/s/', { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024) })
    expect(response.status).toBe(413)
  })

  it('SDK не шлёт заголовков приложения, и гейт версий его не останавливает; CORS-ответ есть', async () => {
    const { app } = makeApp({
      env: POSTHOG,
      analytics: recordingAnalytics(),
      policy: {
        android: { minVersionCode: 100, latestVersionCode: 100, downloadUrl: null },
        ios: { minVersionCode: 0, latestVersionCode: 0, downloadUrl: null },
        js: { latestVersion: null, bundleUrl: null, checksum: null },
      },
    })
    stubPostHog()
    const preflight = await app.request('/api/ingest/e/', {
      method: 'OPTIONS',
      headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

    const response = await app.request('/api/ingest/e/', {
      method: 'POST',
      headers: { Origin: 'https://localhost', [AppHeader.Platform]: AppPlatform.Android, [AppHeader.AppVersion]: '1' },
      body: eventBody,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('недоступный PostHog даёт 502 и не роняет приложение', async () => {
    const { app } = makeApp({ env: POSTHOG, analytics: recordingAnalytics() })
    stubPostHog(() => {
      throw new Error('network down')
    })
    expect((await app.request('/api/ingest/e/', { method: 'POST', body: eventBody })).status).toBe(502)
    // The next, ordinary request is unaffected.
    expect((await app.request('/api/analytics/config')).status).toBe(200)
  })

  it('ограничен по адресу, чтобы не служить чужим бесплатным ретранслятором', async () => {
    const { app } = makeApp({ env: POSTHOG, analytics: recordingAnalytics() })
    stubPostHog()
    const { limit } = RATE_LIMITS.ingest.perIp
    for (let i = 0; i < limit; i += 1) {
      const response = await app.request('/api/ingest/e/', { method: 'POST', body: eventBody })
      if (response.status !== 200) throw new Error(`request ${i} got ${response.status}`)
    }
    expect((await app.request('/api/ingest/e/', { method: 'POST', body: eventBody })).status).toBe(429)
  })
})

describe('события сервера', () => {
  it('регистрация и вход по почте: человек определяется только по id аккаунта', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    const email = uniqueEmail()

    const registered = ok<{ email: string }>(
      await call(app, 'POST', '/api/auth/register', { email, password: PASSWORD, name: 'Аня' }),
    )
    expect(registered.email).toBe(email)
    const created = only(analytics, AnalyticsEvent.AccountCreated)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ properties: { kind: 'email' } })
    const userId = created[0]!.userId!
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(analytics.identified).toContainEqual({ userId, traits: { account_kind: 'email' } })

    ok(await call(app, 'POST', '/api/auth/confirm-email', { email, code: codeFor(email) }))
    expect((await eventually(analytics, AnalyticsEvent.EmailConfirmed)).userId).toBe(userId)

    ok(await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }))
    expect(only(analytics, AnalyticsEvent.LoggedIn)).toEqual([
      { userId, event: 'user_logged_in', properties: { method: 'password' } },
    ])
  })

  it('неудачный вход ничего не сообщает', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    await call(app, 'POST', '/api/auth/login', { email: uniqueEmail(), password: PASSWORD })
    expect(analytics.events).toEqual([])
  })

  it('вход по устройству: новый аккаунт — анонимный, повторный вход — просто вход', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    const body = { deviceId: 'device-analytics-1', deviceKey: 'k'.repeat(40) }

    ok(await call(app, 'POST', '/api/auth/device', body))
    expect(only(analytics, AnalyticsEvent.AccountCreated)).toMatchObject([{ properties: { kind: 'anonymous' } }])
    expect(only(analytics, AnalyticsEvent.LoggedIn)).toMatchObject([{ properties: { method: 'device' } }])
    expect(analytics.identified[0]!.traits).toEqual({ account_kind: 'anonymous' })

    ok(await call(app, 'POST', '/api/auth/device', body))
    expect(only(analytics, AnalyticsEvent.AccountCreated)).toHaveLength(1)
    expect(only(analytics, AnalyticsEvent.LoggedIn)).toHaveLength(2)
  })

  it('согласия, смена пароля, профиль, выход', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    const { user, tokens } = await signUpAndIn(app)
    const userId = user.id

    expect(only(analytics, AnalyticsEvent.ConsentsAccepted)).toMatchObject([
      { userId, properties: { policy_version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } },
    ])

    ok(
      await call(app, 'POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: `${PASSWORD}-new` }, tokens.accessToken),
    )
    expect(only(analytics, AnalyticsEvent.PasswordChanged)).toMatchObject([{ userId }])

    ok(await call(app, 'PATCH', '/api/auth/me', { name: 'Оля', voice: 'female' }, tokens.accessToken))
    expect(only(analytics, AnalyticsEvent.ProfileUpdated)).toEqual([
      { userId, event: 'profile_updated', properties: { fields: ['name', 'voice'] } },
    ])

    ok(await call(app, 'POST', '/api/auth/logout', { refreshToken: tokens.refreshToken }))
    expect(only(analytics, AnalyticsEvent.LoggedOut)).toMatchObject([{ userId, properties: { all_devices: false } }])
  })

  it('«забыл пароль» и удаление аккаунта считаются без человека', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    mockAgent()

    // For an address nobody has registered: the report is the same, so the count cannot leak who exists.
    ok(await call(app, 'POST', '/api/auth/forgot-password', { email: uniqueEmail('stranger') }))
    expect(only(analytics, AnalyticsEvent.PasswordResetRequested)).toEqual([
      { userId: null, event: 'password_reset_requested', properties: {} },
    ])

    const { user, tokens } = await signUpAndIn(app)
    ok(await call(app, 'DELETE', '/api/auth/me', undefined, tokens.accessToken))
    expect(only(analytics, AnalyticsEvent.AccountDeleted)).toEqual([
      { userId: null, event: 'account_deleted', properties: {} },
    ])
    // The promise is "erase everything": the pseudonymous profile in PostHog goes with the account.
    await vi.waitFor(() => expect(analytics.erased).toEqual([user.id]))
  })

  it('диалог: старт и завершение по REST, с изменением напряжения без текста', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs/*/end': () =>
        json({ summary: { title: 'Тяжёлый день', themes: ['работа'], tensionBefore: 8, tensionAfter: 4 } }),
    })
    const { user, tokens } = await signUpAndIn(app)

    ok(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
    expect(only(analytics, AnalyticsEvent.DialogStarted)).toEqual([
      { userId: user.id, event: 'dialog_started', properties: { resumed: false, hours_since_last: null } },
    ])

    ok(await call(app, 'POST', '/api/dialogs/d-1/end', { takeaway: 'секретный вывод', tensionAfter: 4 }, tokens.accessToken))
    const [ended] = only(analytics, AnalyticsEvent.DialogEnded)
    expect(ended).toEqual({
      userId: user.id,
      event: 'dialog_ended',
      properties: { via: 'rest', has_takeaway: true, tension_delta: -4, tension_improved: true },
    })
  })

  it('что бы ни случилось, в отчётах нет ни почты, ни имени, ни текстов', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs/*/end': () =>
        json({ summary: { title: 'Мой секретный заголовок', themes: ['тема'], tensionBefore: 5, tensionAfter: 6 } }),
    })
    const email = uniqueEmail('privacy')
    const login = await signUpAndIn(app, email)
    ok(await call(app, 'PATCH', '/api/auth/me', { name: 'Секретное Имя' }, login.tokens.accessToken))
    ok(await call(app, 'POST', '/api/dialogs', {}, login.tokens.accessToken))
    ok(await call(app, 'POST', '/api/dialogs/d-1/end', { takeaway: 'Секретный вывод' }, login.tokens.accessToken))

    const everything = JSON.stringify([analytics.events, analytics.identified])
    expect(analytics.events.length).toBeGreaterThan(3)
    for (const secret of [email, 'Секретное Имя', 'Секретный вывод', 'секретный заголовок', 'Аня', PASSWORD]) {
      expect(everything).not.toContain(secret)
    }
  })
})
