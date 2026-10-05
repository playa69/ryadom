/**
 * The person's own sessions: the list of devices, ending one, ending the others or all. Whether a
 * session really ends (refresh refused, dialog refused or closed) is covered where the sessions
 * themselves are (`sessions.test.ts`, `dialogs.test.ts`); here it is the routes: who sees what, who
 * may end what.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RefreshApiResponse } from '@ryadom/contracts/api/auth/refresh'
import {
  EndSessionApiErrorCode,
  SessionClient,
  type ListSessionsApiResponse,
} from '@ryadom/contracts/api/auth/sessions'
import type { LoginApiResponse } from '@ryadom/contracts/api/auth/shared'
import { sessionPath } from '@ryadom/contracts/api/paths'
import { PASSWORD, call, makeApp, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

const list = async (accessToken: string) =>
  ok<ListSessionsApiResponse>(await call(app, 'GET', '/api/auth/sessions', undefined, accessToken)).sessions

/** Signs in again with the headers of another device: a second session of the same person. */
async function signInFrom(email: string, headers: Record<string, string>) {
  const login = ok<LoginApiResponse>(
    await call(app, 'POST', '/api/auth/login', { email, password: PASSWORD }, undefined, headers),
  )
  return login.tokens
}

const refresh = (refreshToken: string, headers: Record<string, string> = {}) =>
  call<RefreshApiResponse>(app, 'POST', '/api/auth/refresh', { refreshToken }, undefined, headers)

describe('список сессий', () => {
  it('показывает устройства из x-client-id и User-Agent и отмечает ту, что спрашивает', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = await signInFrom(user.email, { 'x-client-id': 'ryadom-pwa', 'user-agent': CHROME_ANDROID })

    const seenFromPhone = await list(phone.accessToken)
    expect(seenFromPhone).toHaveLength(2)
    const [mine, other] = [seenFromPhone.find((s) => s.current)!, seenFromPhone.find((s) => !s.current)!]
    expect(mine).toMatchObject({ client: SessionClient.Pwa, browser: 'Chrome', os: 'Android' })
    // The first sign-in said nothing about itself: the list says it does not know, and invents nothing.
    expect(other).toMatchObject({ client: null, browser: null, os: null })

    // The same two sessions from the other side: the mark moves, the ids stay.
    const seenFromFirst = await list(tokens.accessToken)
    expect(seenFromFirst.find((s) => s.current)!.id).toBe(other.id)
    expect(new Set(seenFromFirst.map((s) => s.id))).toEqual(new Set(seenFromPhone.map((s) => s.id)))
    expect(Date.parse(mine.startedAt)).toBeLessThanOrEqual(Date.parse(mine.lastUsedAt))
  })

  it('refresh обновляет сведения об устройстве и поднимает сессию наверх', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    await signInFrom(user.email, { 'x-client-id': 'ryadom-web', 'user-agent': CHROME_WINDOWS })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 10 * 60 * 1000)
      // The first device updates itself and now says what it is.
      const next = ok(await refresh(tokens.refreshToken, { 'x-client-id': 'ryadom-ios' }))

      const sessions = await list(next.accessToken)
      expect(sessions[0]).toMatchObject({ current: true, client: SessionClient.Ios })
      expect(sessions[1]).toMatchObject({ current: false, client: SessionClient.Web, browser: 'Chrome' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('неизвестный и подложный x-client-id не становятся клиентом', async () => {
    resetLimits()
    const { user } = await signUpAndIn(app)
    for (const clientId of ['somebody-else', 'constructor', '__proto__', 'toString']) {
      const tokens = await signInFrom(user.email, { 'x-client-id': clientId })
      const current = (await list(tokens.accessToken)).find((s) => s.current)!
      expect(current.client).toBeNull()
    }
  })

  it('чужие сессии не видны, а сессии без токена не отдаются', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const stranger = await signUpAndIn(app)

    expect((await list(tokens.accessToken)).map((s) => s.id)).not.toContain(
      (await list(stranger.tokens.accessToken))[0]!.id,
    )
    expect((await call(app, 'GET', '/api/auth/sessions')).status).toBe(401)
  })

  it('завершённая сессия из списка исчезает', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    await call(app, 'POST', '/api/auth/logout', { refreshToken: tokens.refreshToken })
    const again = await signInFrom(user.email, {})

    expect(await list(again.accessToken)).toHaveLength(1)
  })
})

describe('токен завершённой сессии', () => {
  it('не читает список и не завершает чужие сессии: подпись ещё верна, но сессии нет', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const stolen = await signInFrom(user.email, {})
    const stolenId = (await list(stolen.accessToken)).find((s) => s.current)!.id
    ok(await call(app, 'DELETE', sessionPath(stolenId), undefined, tokens.accessToken))
    const mineId = (await list(tokens.accessToken))[0]!.id

    expect((await call(app, 'GET', '/api/auth/sessions', undefined, stolen.accessToken)).status).toBe(401)
    expect((await call(app, 'DELETE', sessionPath(mineId), undefined, stolen.accessToken)).status).toBe(401)
    expect(
      (await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: false }, stolen.accessToken)).status,
    ).toBe(401)
    // None of it touched the real owner's session.
    expect((await refresh(tokens.refreshToken)).status).toBe(200)
  })
})

describe('завершение одной сессии', () => {
  it('сессия уходит из списка, её refresh отвергается, остальные живы', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = await signInFrom(user.email, { 'x-client-id': 'ryadom-android' })
    const phoneId = (await list(phone.accessToken)).find((s) => s.current)!.id

    ok(await call(app, 'DELETE', sessionPath(phoneId), undefined, tokens.accessToken))

    expect((await list(tokens.accessToken)).map((s) => s.id)).not.toContain(phoneId)
    expect((await refresh(phone.refreshToken)).status).toBe(401)
    expect((await refresh(tokens.refreshToken)).status).toBe(200)
  })

  it('можно завершить и текущую: это выход', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const currentId = (await list(tokens.accessToken)).find((s) => s.current)!.id

    ok(await call(app, 'DELETE', sessionPath(currentId), undefined, tokens.accessToken))

    expect((await refresh(tokens.refreshToken)).status).toBe(401)
  })

  it('чужая, несуществующая, уже завершённая и не-UUID сессии — SESSION_NOT_FOUND, чужая остаётся жить', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const stranger = await signUpAndIn(app)
    const strangerSessionId = (await list(stranger.tokens.accessToken))[0]!.id
    const phone = await signInFrom(user.email, {})
    const endedId = (await list(phone.accessToken)).find((s) => s.current)!.id
    ok(await call(app, 'DELETE', sessionPath(endedId), undefined, tokens.accessToken))

    for (const id of [strangerSessionId, '5f0c6f0e-6b0e-4b0e-8b0e-5f0c6f0e6b0e', endedId, 'not-a-uuid']) {
      refusedWith(
        await call(app, 'DELETE', sessionPath(id), undefined, tokens.accessToken),
        EndSessionApiErrorCode.SESSION_NOT_FOUND,
      )
    }
    expect((await refresh(stranger.tokens.refreshToken)).status).toBe(200)
  })

  it('без токена — 401', async () => {
    expect((await call(app, 'DELETE', sessionPath('5f0c6f0e-6b0e-4b0e-8b0e-5f0c6f0e6b0e'))).status).toBe(401)
  })
})

describe('выйти на всех устройствах', () => {
  it('keepCurrent: остальные завершены, текущая работает', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = await signInFrom(user.email, {})
    const tablet = await signInFrom(user.email, {})

    ok(await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: true }, tokens.accessToken))

    expect((await refresh(phone.refreshToken)).status).toBe(401)
    expect((await refresh(tablet.refreshToken)).status).toBe(401)
    expect((await refresh(tokens.refreshToken)).status).toBe(200)
    expect(await list(tokens.accessToken)).toHaveLength(1)
  })

  it('без keepCurrent завершены все, и текущая тоже', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = await signInFrom(user.email, {})

    ok(await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: false }, tokens.accessToken))

    expect((await refresh(phone.refreshToken)).status).toBe(401)
    expect((await refresh(tokens.refreshToken)).status).toBe(401)
  })

  it('чужие сессии не затрагиваются', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const stranger = await signUpAndIn(app)

    ok(await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: false }, tokens.accessToken))

    expect((await refresh(stranger.tokens.refreshToken)).status).toBe(200)
  })

  it('тело без keepCurrent — 400, ничего не завершено; без токена — 401', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)

    expect((await call(app, 'POST', '/api/auth/logout-all', {}, tokens.accessToken)).status).toBe(400)
    expect(
      (await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: 'yes' }, tokens.accessToken)).status,
    ).toBe(400)
    expect((await refresh(tokens.refreshToken)).status).toBe(200)
    expect((await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: true })).status).toBe(401)
  })
})
