import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type ClientConfig } from '../src/client'
import { ApiError } from '../src/errors'
import { envelope, makeToken, memoryStorage, userOf, type MemoryStorage } from './helpers'

function tokens(refreshToken: string) {
  return { accessToken: 'access-1', refreshToken, expiresAt: Date.now() + 900_000 }
}

function setup(storage: MemoryStorage = memoryStorage(), extra: Partial<ClientConfig> = {}) {
  const onSessionEnd = vi.fn()
  const client = createClient({
    apiBase: () => 'http://api.test',
    wsBase: () => 'ws://api.test',
    storage,
    onSessionEnd,
    ...extra,
  })
  return { client, storage, onSessionEnd }
}

const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function stubFetch() {
  vi.stubGlobal('fetch', fetchMock)
}

describe('сессия: запись в хранилище', () => {
  it('отказ хранилища писать не мешает войти: сессия живёт в памяти', async () => {
    stubFetch()
    const storage = memoryStorage()
    storage.failWrites = true
    const { client } = setup(storage)
    const refresh = makeToken('a')

    await client.startSession(userOf('a'), tokens(refresh))
    expect(client.getAccessToken()).toBe('access-1')

    // The refresh works from memory too, and its answer is kept even though it cannot be stored.
    fetchMock.mockResolvedValueOnce(
      envelope({ accessToken: 'access-2', refreshToken: refresh, expiresAt: 0 }),
    )
    expect(await client.refreshSession()).toBe(true)
    expect(client.getAccessToken()).toBe('access-2')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('без записи в хранилище другая вкладка не считается владельцем сессии', async () => {
    const storage = memoryStorage()
    storage.failWrites = true
    const { client, onSessionEnd } = setup(storage)
    await client.startSession(userOf('a'), tokens(makeToken('a')))

    await client.revalidateSession()
    expect(onSessionEnd).not.toHaveBeenCalled()
  })
})

describe('сессия: обновление токена и выход', () => {
  it('ответ refresh, пришедший после выхода, не возвращает токены', async () => {
    stubFetch()
    const { client, storage } = setup()
    const refresh = makeToken('a')
    await client.startSession(userOf('a'), tokens(refresh))

    let answer!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)))
    const inFlight = client.refreshSession()

    await client.endSession()
    answer(envelope({ accessToken: 'late-access', refreshToken: makeToken('a', 7200, 'late'), expiresAt: 0 }))

    expect(await inFlight).toBe(false)
    expect(storage.refreshToken).toBeNull()
    expect(client.getAccessToken()).toBeNull()
  })

  it('отказ сервера обновить токен завершает сессию и чистит хранилище', async () => {
    stubFetch()
    const { client, storage, onSessionEnd } = setup()
    await client.startSession(userOf('a'), tokens(makeToken('a')))

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect(await client.refreshSession()).toBe(false)

    expect(onSessionEnd).toHaveBeenCalledOnce()
    expect(storage.refreshToken).toBeNull()
    expect(storage.user).toBeNull()
  })

  it('сбой сети при refresh не завершает сессию', async () => {
    stubFetch()
    const { client, storage, onSessionEnd } = setup()
    await client.startSession(userOf('a'), tokens(makeToken('a')))

    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect(await client.refreshSession()).toBe(false)
    expect(onSessionEnd).not.toHaveBeenCalled()
    expect(storage.refreshToken).not.toBeNull()
  })
})

describe('сессия: несколько вкладок на одном хранилище', () => {
  it('чужой аккаунт в хранилище: вкладка выходит и не использует чужой токен', async () => {
    stubFetch()
    const storage = memoryStorage()
    const { client, onSessionEnd } = setup(storage)
    await client.startSession(userOf('a'), tokens(makeToken('a')))

    // Another tab signed out and in as B.
    const theirs = makeToken('b')
    storage.refreshToken = theirs
    storage.user = userOf('b')

    expect(await client.refreshSession()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onSessionEnd).toHaveBeenCalledOnce()
    expect(client.getAccessToken()).toBeNull()
    // B's session is B's: it is neither removed nor overwritten.
    expect(storage.refreshToken).toBe(theirs)
    expect(storage.user).toEqual(userOf('b'))
  })

  it('401 при пустом хранилище доходит до onSessionEnd', async () => {
    stubFetch()
    const storage = memoryStorage()
    const { client, onSessionEnd } = setup(storage)
    await client.startSession(userOf('a'), tokens(makeToken('a')))

    // Another tab signed out.
    storage.refreshToken = null
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))

    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(ApiError)
    expect(onSessionEnd).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('тот же человек вошёл заново в другой вкладке: берём его токен и продолжаем', async () => {
    stubFetch()
    const storage = memoryStorage()
    const { client, onSessionEnd } = setup(storage)
    await client.startSession(userOf('a'), tokens(makeToken('a', 3600, 'first')))

    const newer = makeToken('a', 7200, 'second')
    storage.refreshToken = newer
    fetchMock.mockResolvedValueOnce(envelope({ accessToken: 'access-2', refreshToken: newer, expiresAt: 0 }))

    expect(await client.refreshSession()).toBe(true)
    expect(onSessionEnd).not.toHaveBeenCalled()
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: newer })
  })

  it('revalidateSession: выход в другой вкладке завершает эту сессию, не трогая хранилище', async () => {
    const storage = memoryStorage()
    const { client, onSessionEnd } = setup(storage)
    await client.startSession(userOf('a'), tokens(makeToken('a')))

    await client.revalidateSession()
    expect(onSessionEnd).not.toHaveBeenCalled()

    storage.refreshToken = null
    await client.revalidateSession()
    expect(onSessionEnd).toHaveBeenCalledOnce()
    expect(client.getAccessToken()).toBeNull()

    // Nothing is left to end: a second event is a no-op.
    await client.revalidateSession()
    expect(onSessionEnd).toHaveBeenCalledOnce()
  })

  it('устаревшая вкладка не перезаписывает пользователя в хранилище', async () => {
    const storage = memoryStorage()
    const { client } = setup(storage)
    await client.startSession(userOf('a'), tokens(makeToken('a')))

    storage.refreshToken = makeToken('b')
    storage.user = userOf('b')
    await client.saveUser({ ...userOf('a'), name: 'Новое имя' })

    expect(storage.user).toEqual(userOf('b'))
  })

  it('restoreSession: запись пользователя чужого токена сбрасывается', async () => {
    const storage = memoryStorage()
    storage.refreshToken = makeToken('b')
    storage.user = userOf('a')
    const { client } = setup(storage)

    expect(await client.restoreSession()).toBeNull()
    expect(storage.refreshToken).toBeNull()
    expect(storage.user).toBeNull()
  })

  it('restoreSession: живой токен и свой пользователь — сессия восстановлена', async () => {
    const storage = memoryStorage()
    storage.refreshToken = makeToken('a')
    storage.user = userOf('a')
    const { client } = setup(storage)

    expect(await client.restoreSession()).toEqual(userOf('a'))
  })
})

describe('трассировка', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  function sentHeaders(call: number): Record<string, string> {
    return fetchMock.mock.calls[call]![1]!.headers as Record<string, string>
  }

  it('каждый запрос несёт свой x-trace-id, время, клиента и общую для клиента сессию', async () => {
    stubFetch()
    const { client } = setup(memoryStorage(), { clientId: 'ryadom-web' })
    await client.startSession(userOf('a'), tokens(makeToken('a')))
    fetchMock.mockImplementation(async () => envelope({}))

    await client.getDialog('d-1').catch(() => undefined)
    await client.getDialog('d-2').catch(() => undefined)

    const [first, second] = [sentHeaders(0), sentHeaders(1)]
    expect(first['x-trace-id']).toMatch(UUID)
    expect(second['x-trace-id']).toMatch(UUID)
    expect(first['x-trace-id']).not.toBe(second['x-trace-id'])
    expect(new Date(first['x-request-time']!).toISOString()).toBe(first['x-request-time'])
    expect(first['x-client-id']).toBe('ryadom-web')
    expect(first['x-session-id']).toMatch(UUID)
    expect(second['x-session-id']).toBe(first['x-session-id'])
    // The account comes from the token on the server; a header the client wrote could be forged.
    expect(first).not.toHaveProperty('x-user-id')
    expect(first.Authorization).toBe('Bearer access-1')
  })

  it('без clientId заголовок x-client-id не уходит', async () => {
    stubFetch()
    const { client } = setup()
    await client.startSession(userOf('a'), tokens(makeToken('a')))
    fetchMock.mockImplementation(async () => envelope({}))

    await client.getDialog('d-1').catch(() => undefined)

    expect(sentHeaders(0)).not.toHaveProperty('x-client-id')
    expect(sentHeaders(0)['x-trace-id']).toMatch(UUID)
  })

  it('повтор после обновления токена и сам refresh — отдельные запросы со своими trace id', async () => {
    stubFetch()
    const { client } = setup(memoryStorage(), { clientId: 'ryadom-web' })
    const refresh = makeToken('a')
    await client.startSession(userOf('a'), tokens(refresh))
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(envelope({ accessToken: 'access-2', refreshToken: refresh, expiresAt: 0 }))
      .mockResolvedValueOnce(envelope({}))

    await client.getDialog('d-1').catch(() => undefined)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const traceIds = [0, 1, 2].map((call) => sentHeaders(call)['x-trace-id'])
    expect(new Set(traceIds).size).toBe(3)
    expect(sentHeaders(1)['x-client-id']).toBe('ryadom-web')
  })
})
