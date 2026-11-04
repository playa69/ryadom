/**
 * Routes of the device subscriptions (`openspec/changes/add-push-notifications`, «Подписка устройства»,
 * «Уведомления только открытым сессиям»).
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@ryadom/core/shared'
import { pushSubscriptions } from '@ryadom/db/schema'
import {
  PushSubscriptionApiErrorCode,
  type PushSubscriptionApiResponse,
} from '@ryadom/contracts/api/notifications'
import { createJwt } from '../src/lib/jwt'
import { createSessions } from '../src/lib/sessions'
import { call, expectTransportError, makeApp, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()

const device = (token = 'rustore-token-1') => ({
  channel: 'rustore',
  token,
  projectId: 'testProject_1',
  appId: 'ru.ryadom.companion.dev',
})

const subscribe = (accessToken: string, body: unknown = device()) =>
  call<PushSubscriptionApiResponse>(app, 'POST', '/api/notifications/subscriptions', body, accessToken)

const rows = (userId: string) =>
  getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))

describe('подписка устройства на уведомления', () => {
  it('повторная подписка того же токена — та же подписка, без второй строки', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)

    const first = ok(await subscribe(tokens.accessToken))
    const second = ok(await subscribe(tokens.accessToken))

    expect(second.subscriptionId).toBe(first.subscriptionId)
    expect(await rows(user.id)).toMatchObject([
      {
        channel: 'rustore',
        token: 'rustore-token-1',
        projectId: 'testProject_1',
        appId: 'ru.ryadom.companion.dev',
      },
    ])
  })

  it('на телефоне вошли в другой аккаунт — подписка переходит к нему', async () => {
    resetLimits()
    const before = await signUpAndIn(app)
    const after = await signUpAndIn(app)
    const { subscriptionId } = ok(await subscribe(before.tokens.accessToken))

    expect(ok(await subscribe(after.tokens.accessToken)).subscriptionId).toBe(subscriptionId)
    expect(await rows(before.user.id)).toHaveLength(0)
    expect(await rows(after.user.id)).toHaveLength(1)
  })

  it('чужую подписку снять нельзя, свою — можно, второй раз — отказ', async () => {
    resetLimits()
    const owner = await signUpAndIn(app)
    const stranger = await signUpAndIn(app)
    const { subscriptionId } = ok(await subscribe(owner.tokens.accessToken))
    const path = `/api/notifications/subscriptions/${subscriptionId}`

    refusedWith(
      await call(app, 'DELETE', path, undefined, stranger.tokens.accessToken),
      PushSubscriptionApiErrorCode.SUBSCRIPTION_NOT_FOUND,
    )
    expect(await rows(owner.user.id)).toHaveLength(1)

    expect(ok(await call(app, 'DELETE', path, undefined, owner.tokens.accessToken))).toBeNull()
    expect(await rows(owner.user.id)).toHaveLength(0)
    refusedWith(
      await call(app, 'DELETE', path, undefined, owner.tokens.accessToken),
      PushSubscriptionApiErrorCode.SUBSCRIPTION_NOT_FOUND,
    )
  })

  it('неизвестный канал, пустой токен и лишний формат — 400, подписки нет', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const send = (body: unknown) =>
      app.request('/api/notifications/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify(body),
      })

    await expectTransportError(await send({ ...device(), channel: 'fcm' }), 400)
    await expectTransportError(await send({ ...device(), token: '' }), 400)
    await expectTransportError(await send({ ...device(), projectId: 'a/b' }), 400)
    await expectTransportError(await send({ channel: 'rustore', token: 't' }), 400)
    expect(await rows(user.id)).toHaveLength(0)
  })

  it('без входа и после выхода — 401', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const anonymous = await app.request('/api/notifications/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(device()),
    })
    await expectTransportError(anonymous, 401)

    ok(await call(app, 'POST', '/api/auth/logout', { refreshToken: tokens.refreshToken }))
    expect((await subscribe(tokens.accessToken)).status).toBe(401)
  })

  it('подписка принадлежит сессии: после выхода чистка сессий её удаляет', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    ok(await subscribe(tokens.accessToken))
    expect((await rows(user.id))[0]?.sessionId).toEqual(expect.any(String))

    ok(await call(app, 'POST', '/api/auth/logout', { refreshToken: tokens.refreshToken }))
    // What the hourly job does (`jobs/purge-sessions.ts`).
    await createSessions(createJwt('unused-by-the-purge-0123456789-abcdefghij')).purgeExpired()

    expect(await rows(user.id)).toHaveLength(0)
  })
})
