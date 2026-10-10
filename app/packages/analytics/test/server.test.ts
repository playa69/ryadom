import { describe, expect, it, vi } from 'vitest'
import { AnalyticsEvent } from '../src/events'
import { createServerAnalytics, type ServerAnalyticsClient } from '../src/server'

function fakeClient(overrides: Partial<ServerAnalyticsClient> = {}) {
  const client = {
    capture: vi.fn<ServerAnalyticsClient['capture']>(),
    identify: vi.fn<ServerAnalyticsClient['identify']>(),
    isFeatureEnabled: vi.fn<ServerAnalyticsClient['isFeatureEnabled']>(async () => true),
    captureException: vi.fn<ServerAnalyticsClient['captureException']>(),
    shutdown: vi.fn<ServerAnalyticsClient['shutdown']>(async () => {}),
    on: vi.fn(),
  }
  // An override replaces a mock with the function under test; the mock typing stays for the assertions.
  return Object.assign(client, overrides) as typeof client
}

const base = { host: 'https://eu.i.posthog.com', appEnv: 'staging', service: 'api' }

describe('createServerAnalytics', () => {
  it('без ключа всё выключено и ничего не делает', async () => {
    const analytics = createServerAnalytics({ ...base, key: '' })
    expect(analytics.enabled).toBe(false)
    expect(() => analytics.capture('u1', AnalyticsEvent.EmailConfirmed)).not.toThrow()
    expect(await analytics.isFeatureEnabled('x', 'u1')).toBe(false)
    await expect(analytics.shutdown()).resolves.toBeUndefined()
  })

  it('событие уходит с id аккаунта, окружением и сервисом', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    analytics.capture('user-1', AnalyticsEvent.AccountCreated, { kind: 'email' })
    expect(client.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'account_created',
      properties: { kind: 'email', app_env: 'staging', service: 'api' },
      disableGeoip: true,
    })
  })

  it('свойства проходят очистку: почта и текст не уходят даже по ошибке вызова', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    analytics.capture('user-1', AnalyticsEvent.ProfileUpdated, {
      fields: ['name'],
      email: 'a@b.co',
      takeaway: 'тяжело',
    } as never)
    const { properties } = client.capture.mock.calls[0]![0]
    expect(properties).toEqual({ fields: ['name'], app_env: 'staging', service: 'api' })
  })

  it('анонимное событие не привязано к человеку и не создаёт профиль', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    analytics.captureAnonymous(AnalyticsEvent.SafetySignal, { level: 'crisis' })
    analytics.captureAnonymous(AnalyticsEvent.SafetySignal, { level: 'crisis' })
    const [first, second] = client.capture.mock.calls.map((call) => call[0])
    expect(first!.properties).toMatchObject({ level: 'crisis', $process_person_profile: false })
    expect(first!.distinctId).not.toBe(second!.distinctId)
    expect(first!.distinctId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('identify передаёт только признаки аккаунта', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    analytics.identify('user-1', { account_kind: 'anonymous' })
    expect(client.identify).toHaveBeenCalledWith({
      distinctId: 'user-1',
      properties: { account_kind: 'anonymous' },
      disableGeoip: true,
    })
  })

  it('сбой клиента не доходит до вызывающего кода и сообщается через onError', () => {
    const onError = vi.fn()
    const client = fakeClient({
      capture: vi.fn(() => {
        throw new Error('queue broke')
      }),
    })
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client, onError })
    expect(() => analytics.capture('u', AnalyticsEvent.LoggedOut, { all_devices: false })).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('флаг: при ошибке PostHog — false, а не исключение', async () => {
    const onError = vi.fn()
    const client = fakeClient({ isFeatureEnabled: vi.fn(async () => Promise.reject(new Error('timeout'))) })
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client, onError })
    expect(await analytics.isFeatureEnabled('beta', 'u1')).toBe(false)
    expect(onError).toHaveBeenCalled()
  })

  it('флаг: undefined от PostHog означает «не включён»', async () => {
    const client = fakeClient({ isFeatureEnabled: vi.fn(async () => undefined) })
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    expect(await analytics.isFeatureEnabled('beta', 'u1')).toBe(false)
  })

  it('стирание человека: сначала отправляется очередь, потом PostHog просят удалить профиль', async () => {
    const order: string[] = []
    const client = fakeClient({
      flush: vi.fn(async () => void order.push('flush')),
    })
    const admin = { deletePerson: vi.fn(async () => (order.push('delete'), true)) }
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client, admin })

    expect(analytics.canErase).toBe(true)
    expect(await analytics.erasePerson('user-1')).toBe('erased')
    expect(admin.deletePerson).toHaveBeenCalledWith('user-1')
    // A late event must not be able to bring the profile back after it was erased.
    expect(order).toEqual(['flush', 'delete'])
  })

  it('стирание: отказ PostHog — failed, ключа нет — not_configured', async () => {
    const refusing = createServerAnalytics({
      ...base,
      key: 'phc_test',
      client: fakeClient(),
      admin: { deletePerson: async () => false },
    })
    expect(await refusing.erasePerson('user-1')).toBe('failed')

    const withoutKey = createServerAnalytics({ ...base, key: 'phc_test', client: fakeClient() })
    expect(withoutKey.canErase).toBe(false)
    expect(await withoutKey.erasePerson('user-1')).toBe('not_configured')

    expect(await createServerAnalytics({ ...base, key: '' }).erasePerson('user-1')).toBe('not_configured')
  })

  it('shutdown сбрасывает очередь с ограничением по времени', async () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    await analytics.shutdown()
    expect(client.shutdown).toHaveBeenCalledWith(3000)
  })

  it('ошибки доставки клиента подписаны на onError', () => {
    const onError = vi.fn()
    const client = fakeClient()
    createServerAnalytics({ ...base, key: 'phc_test', client, onError })
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function))
  })
})
