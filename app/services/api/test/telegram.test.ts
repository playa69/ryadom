/**
 * Sign-in from the Telegram Mini App over HTTP: the launch data signed with the bot's key, the account
 * of a Telegram user, and linking a Telegram user to an account that signed in another way.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceLoginApiResponse } from '@ryadom/contracts/api/auth/device'
import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import {
  LinkTelegramApiErrorCode,
  TelegramLoginApiErrorCode,
  type LinkTelegramApiResponse,
  type TelegramLoginApiResponse,
} from '@ryadom/contracts/api/auth/telegram'
import { resetEnvCache } from '@ryadom/core/config'
import { signInitData } from '@ryadom/core/services/telegram-service'
import { call, makeApp, mockAgent, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()

const BOT_TOKEN = '123456789:test-bot-token-for-the-mini-app'
let nextTelegramId = 7_000_000_000

/** Launch data as Telegram makes it for one of its users, `ageSec` seconds after the Mini App opened. */
function launchData(
  telegramId: number,
  options: { ageSec?: number; token?: string; extra?: Record<string, string> } = {},
): string {
  const authDate = Math.floor(Date.now() / 1000) - (options.ageSec ?? 5)
  return signInitData(
    {
      auth_date: String(authDate),
      query_id: 'AAH-test',
      user: JSON.stringify({ id: telegramId, first_name: 'Аня', language_code: 'ru' }),
      ...options.extra,
    },
    options.token ?? BOT_TOKEN,
  )
}

const telegramLogin = (initData: string, createAccount?: boolean) =>
  call<TelegramLoginApiResponse>(app, 'POST', '/api/auth/telegram', { initData, createAccount })

const linkTelegram = (accessToken: string, initData: string) =>
  call<LinkTelegramApiResponse>(app, 'POST', '/api/auth/telegram/link', { initData }, accessToken)

const me = async (accessToken: string) =>
  ok<MeApiResponse>(await call(app, 'GET', '/api/auth/me', undefined, accessToken))

beforeEach(() => {
  resetLimits()
  vi.stubEnv('TELEGRAM_BOT_TOKEN', BOT_TOKEN)
  resetEnvCache()
  nextTelegramId += 1
})

describe('вход через Telegram', () => {
  it('первый вход с экрана согласий заводит аккаунт, следующий находит его', async () => {
    const telegramId = nextTelegramId

    const first = ok(await telegramLogin(launchData(telegramId), true))
    expect(first.isNewAccount).toBe(true)
    expect(first.user).toMatchObject({ email: null, name: null, telegramLinked: true })
    expect(await me(first.tokens.accessToken)).toMatchObject({ id: first.user.id, telegramLinked: true })

    const again = ok(await telegramLogin(launchData(telegramId)))
    expect(again.isNewAccount).toBe(false)
    expect(again.user.id).toBe(first.user.id)
    // An ordinary session: the refresh token rotates like any other.
    ok(await call(app, 'POST', '/api/auth/refresh', { refreshToken: again.tokens.refreshToken }))
  })

  it('тихий вход без аккаунта ничего не заводит', async () => {
    const telegramId = nextTelegramId
    refusedWith(await telegramLogin(launchData(telegramId)), TelegramLoginApiErrorCode.ACCOUNT_NOT_FOUND)
    refusedWith(
      await telegramLogin(launchData(telegramId), false),
      TelegramLoginApiErrorCode.ACCOUNT_NOT_FOUND,
    )
    expect(ok(await telegramLogin(launchData(telegramId), true)).isNewAccount).toBe(true)
  })

  it('данные чужого бота и подправленные данные не принимаются', async () => {
    const telegramId = nextTelegramId
    refusedWith(
      await telegramLogin(launchData(telegramId, { token: '987654321:another-bot' }), true),
      TelegramLoginApiErrorCode.INIT_DATA_INVALID,
    )
    const forged = launchData(telegramId).replace(String(telegramId), String(telegramId + 1))
    refusedWith(await telegramLogin(forged, true), TelegramLoginApiErrorCode.INIT_DATA_INVALID)
    refusedWith(await telegramLogin('user=%7B%7D', true), TelegramLoginApiErrorCode.INIT_DATA_INVALID)
  })

  it('старые данные не принимаются', async () => {
    refusedWith(
      await telegramLogin(launchData(nextTelegramId, { ageSec: 2 * 86_400 }), true),
      TelegramLoginApiErrorCode.INIT_DATA_EXPIRED,
    )
  })

  it('подпись с полем signature принимается', async () => {
    const result = ok(
      await telegramLogin(launchData(nextTelegramId, { extra: { signature: 'c2lnbmF0dXJl' } }), true),
    )
    expect(result.isNewAccount).toBe(true)
  })

  it('без токена бота вход через Telegram выключен', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    resetEnvCache()
    refusedWith(
      await telegramLogin(launchData(nextTelegramId), true),
      TelegramLoginApiErrorCode.NOT_CONFIGURED,
    )
  })

  it('пустые данные — ошибка запроса', async () => {
    const response = await telegramLogin('', true)
    expect(response.status).toBe(400)
  })

  it('удалённый аккаунт отпускает Telegram: следующий вход начинает с чистого листа', async () => {
    mockAgent()
    const telegramId = nextTelegramId
    const first = ok(await telegramLogin(launchData(telegramId), true))

    expect(ok(await call(app, 'DELETE', '/api/auth/me', undefined, first.tokens.accessToken))).toBeNull()

    refusedWith(await telegramLogin(launchData(telegramId)), TelegramLoginApiErrorCode.ACCOUNT_NOT_FOUND)
    const fresh = ok(await telegramLogin(launchData(telegramId), true))
    expect(fresh.isNewAccount).toBe(true)
    expect(fresh.user.id).not.toBe(first.user.id)
  })
})

describe('привязка Telegram', () => {
  it('аккаунт с почтой берёт Telegram, и Mini App открывает его', async () => {
    const telegramId = nextTelegramId
    const { user, tokens } = await signUpAndIn(app)

    expect(ok(await linkTelegram(tokens.accessToken, launchData(telegramId)))).toEqual({
      telegramLinked: true,
    })
    // Again with the same pair: nothing to do, still a success.
    ok(await linkTelegram(tokens.accessToken, launchData(telegramId)))
    expect(await me(tokens.accessToken)).toMatchObject({ telegramLinked: true })

    const signedIn = ok(await telegramLogin(launchData(telegramId)))
    expect(signedIn.user.id).toBe(user.id)
    expect(signedIn.user.email).toBe(user.email)
  })

  it('анонимный аккаунт с Telegram остаётся тем же аккаунтом', async () => {
    const device = { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }
    const anonymous = ok(await call<DeviceLoginApiResponse>(app, 'POST', '/api/auth/device', device))
    ok(await linkTelegram(anonymous.tokens.accessToken, launchData(nextTelegramId)))

    expect(ok(await telegramLogin(launchData(nextTelegramId))).user.id).toBe(anonymous.user.id)
  })

  it('Telegram с другим аккаунтом не перепривязывается', async () => {
    const telegramId = nextTelegramId
    ok(await telegramLogin(launchData(telegramId), true))
    const { tokens } = await signUpAndIn(app)

    refusedWith(
      await linkTelegram(tokens.accessToken, launchData(telegramId)),
      LinkTelegramApiErrorCode.TELEGRAM_TAKEN,
    )
    expect(await me(tokens.accessToken)).toMatchObject({ telegramLinked: false })
  })

  it('у аккаунта уже другой Telegram', async () => {
    const { tokens } = await signUpAndIn(app)
    ok(await linkTelegram(tokens.accessToken, launchData(nextTelegramId)))

    refusedWith(
      await linkTelegram(tokens.accessToken, launchData(nextTelegramId + 500)),
      LinkTelegramApiErrorCode.ALREADY_LINKED,
    )
  })

  it('без входа привязать нельзя, чужие данные не принимаются', async () => {
    const unauthenticated = await call(app, 'POST', '/api/auth/telegram/link', {
      initData: launchData(nextTelegramId),
    })
    expect(unauthenticated.status).toBe(401)

    const { tokens } = await signUpAndIn(app)
    refusedWith(
      await linkTelegram(tokens.accessToken, launchData(nextTelegramId, { token: '987654321:another-bot' })),
      LinkTelegramApiErrorCode.INIT_DATA_INVALID,
    )
  })
})
