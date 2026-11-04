/**
 * Notifications on the phone (`openspec/changes/add-push-notifications`): «Подписка устройства», «Доставка через
 * RuStore Push», «Уведомления только открытым сессиям», «Ничего лишнего в уведомлении»; the admin's message
 * (`admin-console`, «Уведомление человеку из карточки») without the form.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { resetEnvCache } from '../src/config'
import {
  RevokeSessionRefreshTokensCommand,
  RevokeUserRefreshTokensCommand,
  StoreRefreshTokenCommand,
  refreshTokensManager,
} from '../src/managers/refresh-tokens-manager'
import {
  DeleteStalePushSubscriptionsCommand,
  ListActivePushSubscriptionsQuery,
  pushSubscriptionsManager,
} from '../src/managers/push-subscriptions-manager'
import {
  SendUserNotificationOperation,
  SendUserNotificationOperationErrorCode,
  SubscribePushDeviceOperation,
  SubscribePushDeviceOperationErrorCode,
  UnsubscribePushDeviceOperation,
  UnsubscribePushDeviceOperationErrorCode,
  notificationsProcess,
} from '../src/processes/notifications'
import { DeleteUserAccountOperation, accountDeletionProcess } from '../src/processes/account-deletion'
import { getDb, ValidationError } from '../src/shared'
import {
  ADMIN_EMAIL,
  HOUR,
  auditRows,
  json,
  mockAgent,
  mockFetch,
  registerConfirmedUser,
  travelBy,
} from './helpers'

const PROJECT = 'testProject_1'
const OTHER_PROJECT = 'otherProject'
const SEND = 'POST https://vkpns.rustore.ru/v1/projects/*/messages:send'
const DAY = 24 * HOUR

function withServiceTokens(value = `${PROJECT}:service-token-1`): void {
  vi.stubEnv('RUSTORE_PUSH_SERVICE_TOKENS', value)
  resetEnvCache()
}

/** A session of the person, the way sign-in makes one: a refresh token with the session's id. */
async function openSession(userId: string, expiresInMs = 30 * DAY): Promise<string> {
  const sessionId = randomUUID()
  const stored = await refreshTokensManager.execute(
    new StoreRefreshTokenCommand({
      tokenId: randomUUID(),
      sessionId,
      userId,
      expiresAt: new Date(Date.now() + expiresInMs),
      clientId: null,
      userAgent: null,
    }),
  )
  expect(stored).toEqual({ success: true })
  return sessionId
}

async function subscribe(userId: string, sessionId: string, token: string, projectId = PROJECT) {
  const result = await notificationsProcess.execute(
    new SubscribePushDeviceOperation({
      userId,
      sessionId,
      channel: 'rustore',
      token,
      projectId,
      appId: 'ru.ryadom.companion',
    }),
  )
  if (!result.success) throw new Error(`subscribe failed: ${result.error}`)
  return result.subscriptionId
}

const send = (
  userId: string,
  body = 'Завтра с 10:00 до 10:15 разговоры недоступны',
  link: string | null = null,
) =>
  notificationsProcess.execute(
    new SendUserNotificationOperation({ adminEmail: ADMIN_EMAIL, userId, title: 'Обновление', body, link }),
  )

const rowsOf = (userId: string) =>
  getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))

const accepted = () => json({})

describe('подписка устройства', () => {
  it('повторная подписка того же токена — одна подписка с тем же идентификатором', async () => {
    const user = await registerConfirmedUser()
    const sessionId = await openSession(user.id)

    const first = await subscribe(user.id, sessionId, 'token-a')
    const second = await subscribe(user.id, sessionId, 'token-a')

    expect(second).toBe(first)
    expect(await rowsOf(user.id)).toHaveLength(1)
  })

  it('тот же токен из другого аккаунта переходит к нему вместе с сессией', async () => {
    const before = await registerConfirmedUser()
    const after = await registerConfirmedUser()
    const id = await subscribe(before.id, await openSession(before.id), 'phone-token')

    const afterSession = await openSession(after.id)
    expect(await subscribe(after.id, afterSession, 'phone-token')).toBe(id)

    expect(await rowsOf(before.id)).toHaveLength(0)
    expect(await rowsOf(after.id)).toMatchObject([{ id, sessionId: afterSession }])
  })

  it('чужую подписку снять нельзя: отказ, подписка на месте; свою — можно', async () => {
    const owner = await registerConfirmedUser()
    const stranger = await registerConfirmedUser()
    const id = await subscribe(owner.id, await openSession(owner.id), 'token-b')

    expect(
      await notificationsProcess.execute(
        new UnsubscribePushDeviceOperation({ userId: stranger.id, subscriptionId: id }),
      ),
    ).toEqual({ success: false, error: UnsubscribePushDeviceOperationErrorCode.SUBSCRIPTION_NOT_FOUND })
    expect(await rowsOf(owner.id)).toHaveLength(1)

    expect(
      await notificationsProcess.execute(
        new UnsubscribePushDeviceOperation({ userId: owner.id, subscriptionId: id }),
      ),
    ).toEqual({ success: true })
    expect(await rowsOf(owner.id)).toHaveLength(0)
    expect(
      await notificationsProcess.execute(
        new UnsubscribePushDeviceOperation({ userId: owner.id, subscriptionId: 'not-a-uuid' }),
      ),
    ).toEqual({ success: false, error: UnsubscribePushDeviceOperationErrorCode.SUBSCRIPTION_NOT_FOUND })
  })

  it('неизвестный канал, пустой токен и чужой формат проекта — ошибка ввода, подписки нет', async () => {
    const user = await registerConfirmedUser()
    const sessionId = await openSession(user.id)
    const attempt = (fields: Partial<{ channel: string; token: string; projectId: string; appId: string }>) =>
      notificationsProcess.execute(
        new SubscribePushDeviceOperation({
          userId: user.id,
          sessionId,
          channel: 'rustore',
          token: 'token',
          projectId: PROJECT,
          appId: 'ru.ryadom.companion',
          ...fields,
        } as never),
      )

    await expect(attempt({ channel: 'fcm' })).rejects.toBeInstanceOf(ValidationError)
    await expect(attempt({ token: '' })).rejects.toBeInstanceOf(ValidationError)
    await expect(attempt({ projectId: 'a/b' })).rejects.toBeInstanceOf(ValidationError)
    await expect(attempt({ appId: 'not a package' })).rejects.toBeInstanceOf(ValidationError)
    expect(await rowsOf(user.id)).toHaveLength(0)
  })

  it('аккаунта уже нет — отказ без строки', async () => {
    const result = await notificationsProcess.execute(
      new SubscribePushDeviceOperation({
        userId: randomUUID(),
        sessionId: randomUUID(),
        channel: 'rustore',
        token: 'orphan',
        projectId: PROJECT,
        appId: 'ru.ryadom.companion',
      }),
    )
    expect(result).toEqual({ success: false, error: SubscribePushDeviceOperationErrorCode.USER_NOT_FOUND })
  })
})

describe('доставка через RuStore Push', () => {
  it('два телефона в открытых сессиях — два сообщения с заголовком и текстом, итог 2 из 2, запись в журнале', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'phone-1')
    await subscribe(user.id, await openSession(user.id), 'phone-2')
    const { calls } = mockFetch({ [SEND]: accepted })

    expect(await send(user.id)).toEqual({ success: true, sent: 2, total: 2 })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url.pathname).toBe(`/v1/projects/${PROJECT}/messages:send`)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer service-token-1')
    const bodies = calls.map((call) => JSON.parse(call.body) as { message: Record<string, unknown> })
    expect(bodies.map((body) => body.message.token).sort()).toEqual(['phone-1', 'phone-2'])
    expect(bodies[0]!.message).toEqual({
      token: expect.any(String),
      notification: { title: 'Обновление', body: 'Завтра с 10:00 до 10:15 разговоры недоступны' },
      // A day: a phone switched on later does not get it.
      android: { ttl: '86400s' },
    })

    const [entry] = await auditRows()
    expect(entry).toMatchObject({
      adminEmail: ADMIN_EMAIL,
      action: 'USER_NOTIFICATION_SENT',
      targetUserId: user.id,
      targetEmail: user.email,
      payload: {
        title: 'Обновление',
        body: 'Завтра с 10:00 до 10:15 разговоры недоступны',
        sent: 2,
        total: 2,
      },
    })
  })

  it('ссылка на экран уходит в данных, а заголовок и текст — без пробелов по краям', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'phone')
    const { calls } = mockFetch({ [SEND]: accepted })

    await notificationsProcess.execute(
      new SendUserNotificationOperation({
        adminEmail: ADMIN_EMAIL,
        userId: user.id,
        title: '  Дневник  ',
        body: ' Отметь, как прошёл день ',
        link: '/diary/',
      }),
    )

    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      message: {
        notification: { title: 'Дневник', body: 'Отметь, как прошёл день' },
        data: { link: '/diary/' },
      },
    })
  })

  it('токен устарел (404) — подписка удалена, устройство не отправлено, следующая отправка его не трогает', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'old-phone')
    mockFetch({ [SEND]: () => json({ error: { code: 404, status: 'NOT_FOUND' } }, 404) })

    expect(await send(user.id)).toEqual({ success: true, sent: 0, total: 1 })
    expect(await rowsOf(user.id)).toHaveLength(0)

    const { calls } = mockFetch({ [SEND]: accepted })
    expect(await send(user.id)).toEqual({ success: true, sent: 0, total: 0 })
    expect(calls).toHaveLength(0)
  })

  it('другой отказ push-сервиса и обрыв сети — не отправлено, но подписка остаётся', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'phone-500')
    await subscribe(user.id, await openSession(user.id), 'phone-offline')
    mockFetch({
      [SEND]: ({ body }) => {
        if (body.includes('phone-offline')) throw new TypeError('fetch failed')
        return json({ error: { code: 500, status: 'INTERNAL' } }, 500)
      },
    })

    expect(await send(user.id)).toEqual({ success: true, sent: 0, total: 2 })
    expect(await rowsOf(user.id)).toHaveLength(2)
  })

  it('проект без сервисного токена — push-сервис не вызывается, устройство не отправлено, подписка остаётся', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'dev-phone', OTHER_PROJECT)
    await subscribe(user.id, await openSession(user.id), 'release-phone')
    const { calls } = mockFetch({ [SEND]: accepted })

    expect(await send(user.id)).toEqual({ success: true, sent: 1, total: 2 })
    expect(calls.map((call) => call.url.pathname)).toEqual([`/v1/projects/${PROJECT}/messages:send`])
    expect(await rowsOf(user.id)).toHaveLength(2)
  })

  it('у каждого проекта свой сервисный токен', async () => {
    withServiceTokens(`${PROJECT}:token-prod, ${OTHER_PROJECT}:token-test`)
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'dev-phone', OTHER_PROJECT)
    const { calls } = mockFetch({ [SEND]: accepted })

    expect(await send(user.id)).toEqual({ success: true, sent: 1, total: 1 })
    expect(calls[0]!.url.pathname).toBe(`/v1/projects/${OTHER_PROJECT}/messages:send`)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer token-test')
  })

  it('нет подписок — push-сервис не вызывается, итог 0 из 0, запись в журнале есть', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({ [SEND]: accepted })

    expect(await send(user.id)).toEqual({ success: true, sent: 0, total: 0 })
    expect(calls).toHaveLength(0)
    expect(await auditRows()).toMatchObject([
      { action: 'USER_NOTIFICATION_SENT', payload: { sent: 0, total: 0 } },
    ])
  })

  it('неизвестный и удалённый аккаунт — отказ без отправки', async () => {
    mockAgent()
    const user = await registerConfirmedUser()
    await accountDeletionProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )

    expect(await send(randomUUID())).toEqual({
      success: false,
      error: SendUserNotificationOperationErrorCode.USER_NOT_FOUND,
    })
    expect(await send(user.id)).toEqual({
      success: false,
      error: SendUserNotificationOperationErrorCode.USER_DELETED,
    })
  })
})

describe('уведомления только открытым сессиям', () => {
  it('выход на телефоне — на него больше не отправляется, другой телефон получает', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    const leaving = await openSession(user.id)
    await subscribe(user.id, leaving, 'leaving-phone')
    await subscribe(user.id, await openSession(user.id), 'staying-phone')
    await refreshTokensManager.execute(
      new RevokeSessionRefreshTokensCommand({ sessionId: leaving, revokedAt: new Date() }),
    )
    const { calls } = mockFetch({ [SEND]: accepted })

    expect(await send(user.id)).toEqual({ success: true, sent: 1, total: 1 })
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ message: { token: 'staying-phone' } })
  })

  it('все сессии завершены (администратором, блокировкой, сменой пароля) — итог 0 из 0', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'phone')
    await refreshTokensManager.execute(
      new RevokeUserRefreshTokensCommand({ userId: user.id, exceptSessionId: null, revokedAt: new Date() }),
    )
    const { calls } = mockFetch({ [SEND]: accepted })

    expect(await send(user.id)).toEqual({ success: true, sent: 0, total: 0 })
    expect(calls).toHaveLength(0)
  })

  it('истёкшая сессия не получает уведомлений, а чистка удаляет подписки завершённых и истёкших сессий', async () => {
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id, 2 * DAY), 'expiring-phone')
    const ended = await openSession(user.id)
    await subscribe(user.id, ended, 'signed-out-phone')
    await refreshTokensManager.execute(
      new RevokeSessionRefreshTokensCommand({ sessionId: ended, revokedAt: new Date() }),
    )
    await subscribe(user.id, await openSession(user.id), 'live-phone')

    travelBy(3 * DAY)
    const active = await pushSubscriptionsManager.execute(
      new ListActivePushSubscriptionsQuery({ userId: user.id, now: new Date() }),
    )
    expect(active.subscriptions.map((subscription) => subscription.token)).toEqual(['live-phone'])

    await pushSubscriptionsManager.execute(new DeleteStalePushSubscriptionsCommand({ now: new Date() }))
    expect((await rowsOf(user.id)).map((row) => row.token)).toEqual(['live-phone'])
  })
})

describe('ничего лишнего в уведомлении', () => {
  it('текст длиннее 500 символов, пустой текст и длинный заголовок — ошибка ввода, без отправки и записи', async () => {
    withServiceTokens()
    const user = await registerConfirmedUser()
    await subscribe(user.id, await openSession(user.id), 'phone')
    const { calls } = mockFetch({ [SEND]: accepted })

    await expect(send(user.id, 'я'.repeat(501))).rejects.toBeInstanceOf(ValidationError)
    await expect(send(user.id, '   ')).rejects.toBeInstanceOf(ValidationError)
    await expect(
      notificationsProcess.execute(
        new SendUserNotificationOperation({
          adminEmail: ADMIN_EMAIL,
          userId: user.id,
          title: 'з'.repeat(61),
          body: 'Текст',
          link: null,
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(calls).toHaveLength(0)
    expect(await auditRows()).toHaveLength(0)
    expect(await send(user.id, 'я'.repeat(500))).toEqual({ success: true, sent: 1, total: 1 })
  })
})
