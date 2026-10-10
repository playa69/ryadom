/**
 * Product analytics on the server: the config the clients read at startup, the reverse proxy to
 * PostHog, and the events the routes report. Nothing here talks to PostHog: `fetch` is stubbed for the
 * proxy and the reports are recorded by a stand-in.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AnalyticsConfigApiResponse } from '@ryadom/contracts/api/analytics'
import { AppHeader, AppPlatform } from '@ryadom/contracts/api/headers'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { createAnalytics } from '../src/lib/analytics'
import { parseEnv } from '../src/lib/env'
import { createLogger } from '../src/lib/logger'
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
      clickCapture: false,
      heatmapCapture: false,
      errorTracking: true,
      webVitals: true,
      featureFlags: true,
      autocapture: false,
      heatmaps: false,
    })
  })

  it('каждый переключатель включается своей переменной', async () => {
    const { app } = makeApp({
      env: {
        ...POSTHOG,
        POSTHOG_SESSION_REPLAY: 'true',
        POSTHOG_CLICK_CAPTURE: 'on',
        POSTHOG_HEATMAP_CAPTURE: 'yes',
        POSTHOG_ERROR_TRACKING: 'false',
        POSTHOG_WEB_VITALS: '0',
        POSTHOG_FEATURE_FLAGS: 'no',
      },
    })
    const { features } = ok<AnalyticsConfigApiResponse>(await call(app, 'GET', '/api/analytics/config'))
    expect(features).toEqual({
      sessionReplay: true,
      clickCapture: true,
      heatmapCapture: true,
      errorTracking: false,
      webVitals: false,
      featureFlags: false,
      // The names old clients read stay off whatever the switches say: they cannot strip element text
      // or page addresses, so a ConfigMap change must never turn those on in them.
      autocapture: false,
      heatmaps: false,
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
    // The operation names the account itself, so there is no second lookup and no waiting.
    expect(only(analytics, AnalyticsEvent.EmailConfirmed)).toEqual([
      { userId, event: 'email_confirmed', properties: {} },
    ])

    ok(await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }))
    expect(only(analytics, AnalyticsEvent.LoggedIn)).toEqual([
      { userId, event: 'user_logged_in', properties: { method: 'password' } },
    ])
  })

  it('сброс пароля по коду: событие привязано к аккаунту без лишнего запроса', async () => {
    const analytics = recordingAnalytics()
    const { app } = makeApp({ analytics })
    const { user } = await signUpAndIn(app)

    ok(await call(app, 'POST', '/api/auth/forgot-password', { email: user.email }))
    ok(
      await call(app, 'POST', '/api/auth/reset-password', {
        email: user.email,
        code: codeFor(user.email),
        newPassword: `${PASSWORD}-new`,
      }),
    )
    expect(only(analytics, AnalyticsEvent.PasswordResetCompleted)).toEqual([
      { userId: user.id, event: 'password_reset_completed', properties: {} },
    ])
    // The request for the code is counted without a person; the completed reset has one.
    expect(only(analytics, AnalyticsEvent.PasswordResetRequested)).toEqual([
      { userId: null, event: 'password_reset_requested', properties: {} },
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

describe('отказ человека от аналитики (сервер его соблюдает)', () => {
  /** The real analytics wrapper over a stand-in for PostHog's client: what would have been sent is visible. */
  function realAnalytics() {
    const client = {
      capture: vi.fn(),
      identify: vi.fn(),
      isFeatureEnabled: vi.fn(async () => true),
      captureException: vi.fn(),
      shutdown: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      on: vi.fn(),
    }
    const env = parseEnv({ ...process.env, ...POSTHOG })
    const analytics = createAnalytics(env, createLogger('silent'), { client, erasureDelayMs: 0 })
    return { client, analytics }
  }

  const sentFor = (client: { capture: ReturnType<typeof vi.fn> }, userId: string): string[] =>
    client.capture.mock.calls
      .map((call) => call[0] as { distinctId: string; event: string })
      .filter((message) => message.distinctId === userId)
      .map((message) => message.event)

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60))

  it('профиль по умолчанию говорит, что аналитика включена', async () => {
    const { app } = makeApp()
    const { tokens } = await signUpAndIn(app)
    const me = ok<{ analyticsOptOut: boolean }>(await call(app, 'GET', '/api/auth/me', undefined, tokens.accessToken))
    expect(me.analyticsOptOut).toBe(false)
  })

  it('после отказа сервер молчит о человеке на любом устройстве; о других говорит; возвращение включает снова', async () => {
    const { client, analytics } = realAnalytics()
    const { app } = makeApp({ env: POSTHOG, analytics })
    mockAgent()
    const email = uniqueEmail('quiet')
    const quiet = await signUpAndIn(app, email)
    await vi.waitFor(() => expect(sentFor(client, quiet.user.id).length).toBeGreaterThan(0))

    const patched = ok<{ analyticsOptOut: boolean }>(
      await call(app, 'PATCH', '/api/auth/me', { analyticsOptOut: true }, quiet.tokens.accessToken),
    )
    expect(patched.analyticsOptOut).toBe(true)

    // Another device of the same person: a fresh sign-in and a conversation. Nothing about them leaves.
    const before = sentFor(client, quiet.user.id).length
    const identifiedBefore = client.identify.mock.calls.length
    const phone = ok<{ tokens: { accessToken: string } }>(
      await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }),
    )
    ok(await call(app, 'POST', '/api/dialogs', {}, phone.tokens.accessToken))
    await settle()
    expect(sentFor(client, quiet.user.id)).toHaveLength(before)
    expect(client.identify.mock.calls.length).toBe(identifiedBefore)

    // Somebody else is reported as usual.
    const other = await signUpAndIn(app)
    await vi.waitFor(() => expect(sentFor(client, other.user.id)).toContain('consents_accepted'))

    // Turning it back on is the person's own act, and it counts from the next report.
    ok(await call(app, 'PATCH', '/api/auth/me', { analyticsOptOut: false }, phone.tokens.accessToken))
    ok(await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }))
    await vi.waitFor(() => expect(sentFor(client, quiet.user.id).length).toBeGreaterThan(before))
  })

  it('само включение отказа не порождает события, и в профиль это не попадает как «изменение»', async () => {
    const { client, analytics } = realAnalytics()
    const { app } = makeApp({ env: POSTHOG, analytics })
    const { user, tokens } = await signUpAndIn(app)
    await vi.waitFor(() => expect(sentFor(client, user.id).length).toBeGreaterThan(0))
    const before = sentFor(client, user.id).length

    ok(await call(app, 'PATCH', '/api/auth/me', { analyticsOptOut: true }, tokens.accessToken))
    await settle()
    expect(sentFor(client, user.id)).toHaveLength(before)
    expect(sentFor(client, user.id)).not.toContain('profile_updated')
  })

  it('PATCH без единого поля по-прежнему 422', async () => {
    const { app } = makeApp()
    const { tokens } = await signUpAndIn(app)
    const response = await app.request('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
      body: '{}',
    })
    expect(response.status).toBe(422)
  })

  it('о несуществующем или стёртом аккаунте событий нет', async () => {
    const { client, analytics } = realAnalytics()
    // A person who does not exist: the question is answered "gone", which counts as "no reports".
    analytics.capture('00000000-0000-4000-8000-000000000000', AnalyticsEvent.SessionRevoked)
    await settle()
    expect(client.capture).not.toHaveBeenCalled()
  })
})
