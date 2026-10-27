import { describe, expect, it, vi } from 'vitest'
import { AnalyticsEvent } from '../src/events'
import { createServerAnalytics, type ServerAnalyticsClient } from '../src/server'

function fakeClient(overrides: Partial<ServerAnalyticsClient> = {}) {
  const client = {
    capture: vi.fn<ServerAnalyticsClient['capture']>(),
    identify: vi.fn<ServerAnalyticsClient['identify']>(),
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
    await expect(analytics.shutdown()).resolves.toBeUndefined()
  })

  it('событие уходит с id аккаунта, окружением и сервисом', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    analytics.capture('user-1', AnalyticsEvent.AccountCreated, { kind: 'email' })
    expect(client.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'account_created',
      properties: { kind: 'email', app_env: 'staging', service: 'api', traffic_type: 'real' },
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
    expect(properties).toEqual({ fields: ['name'], app_env: 'staging', service: 'api', traffic_type: 'real' })
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

  it('анонимное событие датируется началом часа, событие о человеке своим временем', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    analytics.captureAnonymous(AnalyticsEvent.SafetySignal, { level: 'crisis' })
    analytics.capture('user-1', AnalyticsEvent.EmailConfirmed)
    const [anonymous, person] = client.capture.mock.calls.map((call) => call[0])
    expect(anonymous!.timestamp).toBeInstanceOf(Date)
    expect(anonymous!.timestamp!.getTime() % 3_600_000).toBe(0)
    expect(Date.now() - anonymous!.timestamp!.getTime()).toBeLessThan(3_600_000 + 1000)
    expect(person!.timestamp).toBeUndefined()
  })

  it('ошибка сервера уходит обезличенной: кусок введённого текста, адрес и почта заменены', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    const error = new SyntaxError(`Unexpected token 'П', "Привет, мне сегодня тяжело"... at https://app.example/x?code=SECRET, a@b.co`)
    analytics.captureException(error)
    const sent = client.captureException.mock.calls[0]![0] as Error
    expect(sent.name).toBe('SyntaxError')
    expect(sent.message).not.toMatch(/Привет|SECRET|a@b\.co/)
    expect(sent.message.length).toBeLessThanOrEqual(80)
    expect(sent.stack).not.toMatch(/Привет|SECRET/)
    expect(sent.stack).toMatch(/^SyntaxError: /)
  })

  it('identify передаёт только признаки аккаунта', () => {
    const client = fakeClient()
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
    analytics.identify('user-1', { account_kind: 'anonymous' })
    expect(client.identify).toHaveBeenCalledWith({
      distinctId: 'user-1',
      properties: { account_kind: 'anonymous', traffic_type: 'real' },
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

  it('стирание человека: сначала отправляется очередь, потом PostHog просят удалить профиль', async () => {
    const order: string[] = []
    const client = fakeClient({
      flush: vi.fn(async () => void order.push('flush')),
    })
    const admin = { deletePerson: vi.fn(async () => (order.push('delete'), true)) }
    const analytics = createServerAnalytics({ ...base, key: 'phc_test', client, admin, erasureDelayMs: 0 })

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
      erasureDelayMs: 0,
    })
    expect(await refusing.erasePerson('user-1')).toBe('failed')

    const withoutKey = createServerAnalytics({ ...base, key: 'phc_test', client: fakeClient() })
    expect(withoutKey.canErase).toBe(false)
    expect(await withoutKey.erasePerson('user-1')).toBe('not_configured')

    expect(await createServerAnalytics({ ...base, key: '' }).erasePerson('user-1')).toBe('not_configured')
  })

  it('стирание откладывается: запоздавший клиентский батч не успевает воскресить профиль', async () => {
    vi.useFakeTimers()
    try {
      const admin = { deletePerson: vi.fn(async () => true) }
      const analytics = createServerAnalytics({
        ...base,
        key: 'phc_test',
        client: fakeClient(),
        admin,
        erasureDelayMs: 30_000,
      })
      const outcome = analytics.erasePerson('user-1')
      await vi.advanceTimersByTimeAsync(29_000)
      expect(admin.deletePerson).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_500)
      expect(admin.deletePerson).toHaveBeenCalledWith('user-1')
      expect(await outcome).toBe('erased')
    } finally {
      vi.useRealTimers()
    }
  })

  it('остановка пода не теряет ожидающее стирание: оно исполняется сразу, ровно один раз', async () => {
    const admin = { deletePerson: vi.fn(async () => true) }
    const analytics = createServerAnalytics({
      ...base,
      key: 'phc_test',
      client: fakeClient(),
      admin,
      erasureDelayMs: 60_000,
    })
    const outcome = analytics.erasePerson('user-1')
    expect(admin.deletePerson).not.toHaveBeenCalled()
    await analytics.shutdown()
    expect(admin.deletePerson).toHaveBeenCalledTimes(1)
    expect(await outcome).toBe('erased')
  })

  describe('тип трафика аккаунта', () => {
    it('каждое событие человека и его профиль несут traffic_type аккаунта', async () => {
      const client = fakeClient()
      const analytics = createServerAnalytics({
        ...base,
        key: 'phc_test',
        client,
        accountState: async (userId) => ({ optOut: false, trafficType: userId === 'bot' ? 'test' : 'real' }),
      })
      analytics.capture('bot', AnalyticsEvent.DialogTurn, { input: 'text' })
      analytics.capture('human', AnalyticsEvent.DialogTurn, { input: 'text' })
      analytics.identify('bot', { account_kind: 'anonymous' })
      await vi.waitFor(() => expect(client.capture).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(client.identify).toHaveBeenCalledTimes(1))

      const byUser = Object.fromEntries(client.capture.mock.calls.map(([m]) => [m.distinctId, m.properties]))
      expect(byUser.bot).toMatchObject({ traffic_type: 'test' })
      expect(byUser.human).toMatchObject({ traffic_type: 'real' })
      expect(client.identify.mock.calls[0]![0].properties).toMatchObject({ traffic_type: 'test', account_kind: 'anonymous' })
    })

    it('вызывающий не может подставить traffic_type сам: его значение перекрывается аккаунтом', async () => {
      const client = fakeClient()
      const analytics = createServerAnalytics({
        ...base,
        key: 'phc_test',
        client,
        accountState: async () => ({ optOut: false, trafficType: 'test' }),
      })
      analytics.identify('u', { account_kind: 'email', traffic_type: 'real' })
      await vi.waitFor(() => expect(client.identify).toHaveBeenCalledTimes(1))
      expect(client.identify.mock.calls[0]![0].properties).toMatchObject({ traffic_type: 'test' })
    })

    it('без accountState аккаунт считается обычным', () => {
      const client = fakeClient()
      const analytics = createServerAnalytics({ ...base, key: 'phc_test', client })
      analytics.capture('u', AnalyticsEvent.DialogTurn, { input: 'voice' })
      expect(client.capture.mock.calls[0]![0].properties).toMatchObject({ traffic_type: 'real' })
    })

    it('setOptOut(false) для аккаунта, о котором не спрашивали, не выдумывает тип трафика', async () => {
      const client = fakeClient()
      const accountState = vi.fn(async () => ({ optOut: false, trafficType: 'test' as const }))
      const analytics = createServerAnalytics({ ...base, key: 'phc_test', client, accountState })
      analytics.setOptOut('u', false)
      analytics.capture('u', AnalyticsEvent.DialogTurn, { input: 'text' })
      await vi.waitFor(() => expect(client.capture).toHaveBeenCalledTimes(1))
      expect(accountState).toHaveBeenCalledTimes(1)
      expect(client.capture.mock.calls[0]![0].properties).toMatchObject({ traffic_type: 'test' })
    })
  })

  it('app_version берётся из релиза сборки и не выдумывается, когда его нет', () => {
    const withRelease = fakeClient()
    createServerAnalytics({ ...base, key: 'phc_test', client: withRelease, release: '0.6.0' }).capture(
      'u',
      AnalyticsEvent.EmailConfirmed,
    )
    expect(withRelease.capture.mock.calls[0]![0].properties).toMatchObject({ app_version: '0.6.0' })

    const without = fakeClient()
    createServerAnalytics({ ...base, key: 'phc_test', client: without }).capture('u', AnalyticsEvent.EmailConfirmed)
    expect(without.capture.mock.calls[0]![0].properties).not.toHaveProperty('app_version')
  })

  describe('отказ человека от аналитики', () => {
    it('не отправляет ничего о человеке, который отказался; о других отправляет', async () => {
      const client = fakeClient()
      const accountState = vi.fn(async (userId: string) => ({ optOut: userId === 'quiet', trafficType: 'real' as const }))
      const analytics = createServerAnalytics({ ...base, key: 'phc_test', client, accountState })

      analytics.capture('quiet', AnalyticsEvent.LoggedOut, { all_devices: false })
      analytics.identify('quiet', { account_kind: 'email' })
      analytics.captureException(new Error('x'), 'quiet')
      analytics.capture('talker', AnalyticsEvent.LoggedOut, { all_devices: false })
      await vi.waitFor(() => expect(client.capture).toHaveBeenCalledTimes(1))

      expect(client.capture.mock.calls[0]![0]).toMatchObject({ distinctId: 'talker' })
      expect(client.identify).not.toHaveBeenCalled()
      expect(client.captureException).not.toHaveBeenCalled()
    })

    it('спрашивает один раз на пачку событий и помнит ответ', async () => {
      const client = fakeClient()
      const accountState = vi.fn(async () => ({ optOut: false, trafficType: 'real' as const }))
      const analytics = createServerAnalytics({ ...base, key: 'phc_test', client, accountState })

      analytics.capture('u', AnalyticsEvent.LoggedOut, { all_devices: false })
      analytics.capture('u', AnalyticsEvent.SessionRevoked)
      analytics.capture('u', AnalyticsEvent.PasswordChanged)
      await vi.waitFor(() => expect(client.capture).toHaveBeenCalledTimes(3))
      analytics.capture('u', AnalyticsEvent.EmailLinked)
      expect(client.capture).toHaveBeenCalledTimes(4)
      expect(accountState).toHaveBeenCalledTimes(1)
    })

    it('setOptOut действует сразу, не дожидаясь, пока забудется прежний ответ', async () => {
      const client = fakeClient()
      const analytics = createServerAnalytics({
        ...base,
        key: 'phc_test',
        client,
        accountState: async () => ({ optOut: false, trafficType: 'real' }),
      })
      analytics.capture('u', AnalyticsEvent.SessionRevoked)
      await vi.waitFor(() => expect(client.capture).toHaveBeenCalledTimes(1))

      analytics.setOptOut('u', true)
      analytics.capture('u', AnalyticsEvent.SessionRevoked)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(client.capture).toHaveBeenCalledTimes(1)

      analytics.setOptOut('u', false)
      analytics.capture('u', AnalyticsEvent.SessionRevoked)
      expect(client.capture).toHaveBeenCalledTimes(2)
    })

    it('если ответить на вопрос не удалось, событие отбрасывается, а не отправляется', async () => {
      const onError = vi.fn()
      const client = fakeClient()
      const analytics = createServerAnalytics({
        ...base,
        key: 'phc_test',
        client,
        onError,
        accountState: async () => Promise.reject(new Error('db down')),
      })
      analytics.capture('u', AnalyticsEvent.SessionRevoked)
      await vi.waitFor(() => expect(onError).toHaveBeenCalled())
      expect(client.capture).not.toHaveBeenCalled()
    })

    it('анонимные события не зависят от выбора: у них нет человека', () => {
      const client = fakeClient()
      const analytics = createServerAnalytics({
        ...base,
        key: 'phc_test',
        client,
        accountState: async () => ({ optOut: true, trafficType: 'real' }),
      })
      analytics.captureAnonymous(AnalyticsEvent.SafetySignal, { level: 'crisis' })
      expect(client.capture).toHaveBeenCalledTimes(1)
    })
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
