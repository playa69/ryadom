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
