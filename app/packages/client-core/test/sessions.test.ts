/**
 * The person's own sessions as the client asks for them: the list, ending another device's session,
 * and "sign out on all devices".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionClient, type SessionApiResponse } from '@ryadom/contracts/api/auth/sessions'
import { createClient } from '../src/client'
import { envelope, makeToken, memoryStorage, userOf } from './helpers'

const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

async function setup() {
  vi.stubGlobal('fetch', fetchMock)
  const client = createClient({
    apiBase: () => 'http://api.test',
    wsBase: () => 'ws://api.test',
    storage: memoryStorage(),
  })
  await client.startSession(userOf('u1'), {
    accessToken: 'access-1',
    refreshToken: makeToken('u1'),
    expiresAt: Date.now() + 900_000,
  })
  return client
}

const headersOf = (call: number) => fetchMock.mock.calls[call]![1]!.headers as Record<string, string>
const sentBody = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]![1]!.body))

const session = (id: string, current = false): SessionApiResponse => ({
  id,
  current,
  client: SessionClient.Web,
  browser: 'Chrome',
  os: 'Windows',
  startedAt: '2026-10-04T10:00:00.000Z',
  lastUsedAt: '2026-10-04T11:00:00.000Z',
})

describe('список сессий', () => {
  it('читает список с токеном сессии и отдаёт сами сессии', async () => {
    const client = await setup()
    fetchMock.mockResolvedValue(envelope({ sessions: [session('s1', true), session('s2')] }))

    const sessions = await client.listSessions()

    expect(sessions.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(sessions[0]!.current).toBe(true)
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/auth/sessions')
    expect(headersOf(0).Authorization).toBe('Bearer access-1')
  })

  it('сбой сервера — исключение, а не пустой список: пустой список значил бы «других устройств нет»', async () => {
    const client = await setup()
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))

    await expect(client.listSessions()).rejects.toMatchObject({ status: 500 })
  })
})

describe('завершение сессии другого устройства', () => {
  it('DELETE по id сессии, id экранируется', async () => {
    const client = await setup()
    fetchMock.mockResolvedValue(envelope(null))

    const outcome = await client.revokeSession('a/b c')

    expect(outcome).toEqual({ ok: true, data: undefined })
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/auth/sessions/a%2Fb%20c')
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('DELETE')
    expect(headersOf(0).Authorization).toBe('Bearer access-1')
  })

  it('«сессии уже нет» приходит кодом, а не исключением', async () => {
    const client = await setup()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: false, errorCode: 'SESSION_NOT_FOUND' }), { status: 200 }),
    )

    expect(await client.revokeSession('s2')).toEqual({ ok: false, code: 'SESSION_NOT_FOUND' })
  })
})

describe('выйти на всех устройствах', () => {
  it.each([true, false])('отправляет keepCurrent=%s', async (keepCurrent) => {
    const client = await setup()
    fetchMock.mockResolvedValue(envelope(null))

    await client.signOutEverywhere(keepCurrent)

    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/auth/logout-all')
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST')
    expect(sentBody(0)).toEqual({ keepCurrent })
    expect(headersOf(0).Authorization).toBe('Bearer access-1')
  })

  it('отказ сервера — исключение: человек не должен думать, что вышел везде', async () => {
    const client = await setup()
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))

    await expect(client.signOutEverywhere(true)).rejects.toMatchObject({ status: 500 })
  })
})
