/**
 * Anonymous identity of a device: made once, saved before the server hears of it, kept through
 * signing out, and given up only on request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { createClient } from '../src/client'
import { newDeviceCredentials } from '../src/device'
import { ApiError } from '../src/errors'
import { envelope, makeToken, memoryStorage, userOf, type MemoryStorage } from './helpers'

const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function setup(storage: MemoryStorage = memoryStorage()) {
  vi.stubGlobal('fetch', fetchMock)
  const client = createClient({ apiBase: () => 'http://api.test', wsBase: () => 'ws://api.test', storage })
  return { client, storage }
}

const tokens = () => ({
  accessToken: 'access-1',
  refreshToken: makeToken('anon'),
  expiresAt: Date.now() + 900_000,
})

const answer = () =>
  envelope({ user: { id: 'anon', email: null, name: null }, tokens: tokens(), isNewAccount: true })

const sentBody = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]![1]!.body))

describe('удостоверение устройства', () => {
  it('случайные, нужной формы и не повторяются', () => {
    const a = newDeviceCredentials()
    const b = newDeviceCredentials()

    expect(a.deviceId).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(a.deviceKey).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
    expect(a.deviceId).not.toBe(b.deviceId)
    expect(a.deviceKey).not.toBe(b.deviceKey)
    expect(a.deviceKey).not.toBe(a.deviceId)
  })

  it('без криптографического генератора случайных чисел не подставляет слабый', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => newDeviceCredentials()).toThrow(/random/i)
  })
})

describe('вход по устройству', () => {
  it('первый вход делает удостоверение, сохраняет его до запроса и отправляет', async () => {
    const { client, storage } = setup()
    let savedBeforeRequest: unknown = null
    fetchMock.mockImplementation(async () => {
      savedBeforeRequest = storage.device
      return answer()
    })

    const result = await client.deviceLogin()

    expect(result).toMatchObject({ isNewAccount: true, user: { id: 'anon', email: null } })
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/auth/device')
    expect(sentBody(0)).toEqual(storage.device)
    // Saved first: an account made for an identity that was then lost could never be reached again.
    expect(savedBeforeRequest).toEqual(storage.device)
    expect(storage.device).toEqual({
      deviceId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
      deviceKey: expect.stringMatching(/^[A-Za-z0-9_-]{32,128}$/),
    })
  })

  it('следующие входы используют то же удостоверение', async () => {
    const { client, storage } = setup()
    fetchMock.mockImplementation(async () => answer())

    await client.deviceLogin()
    const first = storage.device
    await client.deviceLogin()

    expect(storage.device).toBe(first)
    expect(sentBody(1)).toEqual(sentBody(0))
  })

  it('вход сессию не начинает: это делает вызывающий, как после обычного входа', async () => {
    const { client } = setup()
    fetchMock.mockImplementation(async () => answer())

    const { user, tokens: issued } = await client.deviceLogin()
    expect(client.getAccessToken()).toBeNull()

    await client.startSession(user, issued)
    expect(client.getAccessToken()).toBe('access-1')
  })

  it('хранилище не принимает запись — вход всё равно работает на время сессии', async () => {
    const storage = memoryStorage()
    storage.setDevice = async () => {
      throw new Error('quota exceeded')
    }
    const { client } = setup(storage)
    fetchMock.mockImplementation(async () => answer())

    await expect(client.deviceLogin()).resolves.toMatchObject({ isNewAccount: true })
  })

  it('хранилище не читается — нового удостоверения не заводит, запроса нет', async () => {
    const storage = memoryStorage()
    storage.getDevice = async () => {
      throw new Error('storage unavailable')
    }
    const { client } = setup(storage)

    await expect(client.deviceLogin()).rejects.toThrow('storage unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('сервер не принял ключ — ApiError 401, удостоверение остаётся', async () => {
    const storage = memoryStorage()
    storage.device = newDeviceCredentials()
    const kept = storage.device
    const { client } = setup(storage)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ errorMessage: 'no' }), { status: 401 }))

    await expect(client.deviceLogin()).rejects.toMatchObject({ status: 401 })
    await expect(client.deviceLogin()).rejects.toBeInstanceOf(ApiError)
    expect(storage.device).toBe(kept)
  })
})

describe('удостоверение и сессия', () => {
  it('выход из аккаунта удостоверение не трогает: по нему аккаунт находится снова', async () => {
    const { client, storage } = setup()
    fetchMock.mockImplementation(async () => answer())
    const { user, tokens: issued } = await client.deviceLogin()
    await client.startSession(user, issued)

    await client.signOut()

    expect(storage.refreshToken).toBeNull()
    expect(storage.device).not.toBeNull()
  })

  it('forgetDevice стирает его — после удаления аккаунта', async () => {
    const storage = memoryStorage()
    storage.device = newDeviceCredentials()
    const { client } = setup(storage)

    await client.forgetDevice()

    expect(storage.device).toBeNull()
  })

  it('сбой хранилища при стирании не мешает', async () => {
    const storage = memoryStorage()
    storage.setDevice = async () => {
      throw new Error('blocked')
    }
    const { client } = setup(storage)

    await expect(client.forgetDevice()).resolves.toBeUndefined()
  })

  it('hasDevice: удостоверения нет до первого входа, есть после и снова нет после забывания', async () => {
    const { client } = setup()
    fetchMock.mockImplementation(async () => answer())

    expect(await client.hasDevice()).toBe(false)
    await client.deviceLogin()
    expect(await client.hasDevice()).toBe(true)
    await client.forgetDevice()
    expect(await client.hasDevice()).toBe(false)
  })

  it('hasDevice: хранилище не читается — «нет», первый экран безопаснее сбоя', async () => {
    const storage = memoryStorage()
    storage.getDevice = async () => {
      throw new Error('storage unavailable')
    }
    const { client } = setup(storage)

    expect(await client.hasDevice()).toBe(false)
  })
})

describe('согласия', () => {
  it('три сразу, в версии этой сборки, с токеном сессии', async () => {
    const { client } = setup()
    await client.startSession(userOf('anon'), tokens())
    fetchMock.mockResolvedValue(envelope({ consentsCompleted: true, acceptedAt: '2026-10-04T10:00:00.000Z' }))

    const outcome = await client.acceptConsents()

    expect(outcome).toEqual({
      ok: true,
      data: { consentsCompleted: true, acceptedAt: '2026-10-04T10:00:00.000Z' },
    })
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/auth/me/consents')
    expect(sentBody(0)).toEqual({
      ageConfirmed: true,
      disclaimerAccepted: true,
      offerAccepted: true,
      offerVersion: POLICY_VERSION,
    })
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-1',
    )
  })

  it('версию можно назвать явно', async () => {
    const { client } = setup()
    await client.startSession(userOf('anon'), tokens())
    fetchMock.mockResolvedValue(envelope({ consentsCompleted: true, acceptedAt: '2027-02-01T00:00:00.000Z' }))

    await client.acceptConsents('2027-02-01')

    expect(sentBody(0)).toMatchObject({ offerVersion: '2027-02-01' })
  })

  it('отказ сервера приходит кодом, а не исключением', async () => {
    const { client } = setup()
    await client.startSession(userOf('anon'), tokens())
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: false, errorCode: 'AGE_RESTRICTED' }), { status: 200 }),
    )

    expect(await client.acceptConsents()).toEqual({ ok: false, code: 'AGE_RESTRICTED' })
  })
})

describe('привязка почты', () => {
  it('отправляет почту и пароль, возвращает принятый адрес', async () => {
    const { client } = setup()
    await client.startSession(userOf('anon'), tokens())
    fetchMock.mockResolvedValue(envelope({ email: 'a@example.com', emailConfirmationRequired: true }))

    const outcome = await client.linkEmail('A@example.com', 'long-enough-password')

    expect(outcome).toEqual({ ok: true, data: { email: 'a@example.com', emailConfirmationRequired: true } })
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/auth/email/link')
    expect(sentBody(0)).toEqual({ email: 'A@example.com', password: 'long-enough-password' })
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-1',
    )
  })

  it('отказ сервера приходит кодом, а не исключением', async () => {
    const { client } = setup()
    await client.startSession(userOf('anon'), tokens())
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: false, errorCode: 'EMAIL_TAKEN' }), { status: 200 }),
    )

    expect(await client.linkEmail('taken@example.com', 'long-enough-password')).toEqual({
      ok: false,
      code: 'EMAIL_TAKEN',
    })
  })
})
