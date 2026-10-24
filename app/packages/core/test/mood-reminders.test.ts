/**
 * The mood reminder (`REQ-WELL-02`, `openspec/changes/add-mood-diary`): the rules of sending, one
 * delivery per day whatever the number of replicas, the pause after seven unopened, dead addresses.
 */
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { moodCheckins, notificationDeliveries, notificationSettings, pushSubscriptions, users } from '@ryadom/db/schema'
import {
  CreateSubscriptionOperation,
  GetNotificationSettingsOperation,
  MarkReminderOpenedOperation,
  notificationsProcess,
  NotificationsOperationErrorCode,
  RunReminderTickOperation,
  UpdateNotificationSettingsOperation,
} from '../src/processes/notifications'
import {
  setReminderTransport,
  type DeliveryOutcome,
  type ReminderTransport,
} from '../src/services/reminder-delivery-service'
import { getDb } from '../src/shared'
import { registerConfirmedUser } from './helpers'

/** 20:05 in Moscow on Saturday 24 Oct 2026. */
const EVENING = new Date('2026-10-24T17:05:00Z')
const LOCAL_DATE = '2026-10-24'

interface Sent {
  kind: 'web_push' | 'telegram'
  target: string
  text: string
}

function fakeTransport(outcome: DeliveryOutcome = { ok: true }) {
  const sent: Sent[] = []
  const transport: ReminderTransport = {
    async sendWebPush(target, payload) {
      sent.push({ kind: 'web_push', target: target.endpoint, text: payload.body })
      return outcome
    },
    async sendTelegram(chatId, text) {
      sent.push({ kind: 'telegram', target: String(chatId), text })
      return outcome
    },
  }
  setReminderTransport(transport)
  return sent
}

afterEach(() => setReminderTransport())

const tick = (now: Date) => notificationsProcess.execute(new RunReminderTickOperation({ now }))

async function personWithPush(endpoint = `https://push.example/${Math.random()}`) {
  const user = await registerConfirmedUser()
  const created = await notificationsProcess.execute(
    new CreateSubscriptionOperation({ userId: user.id, channel: 'web_push', endpoint, p256dh: 'p', auth: 'a', deviceLabel: 'Chrome' }),
  )
  if (!created.success) throw new Error('no subscription')
  return { user, subscriptionId: created.id, endpoint }
}

describe('настройка напоминания', () => {
  it('по умолчанию включено на 20:00; время — с 08:00 до 22:30 с шагом 30 минут', async () => {
    const user = await registerConfirmedUser()
    const read = () => notificationsProcess.execute(new GetNotificationSettingsOperation({ userId: user.id }))
    expect(await read()).toMatchObject({ success: true, settings: { moodReminderEnabled: true, moodReminderTime: '20:00', paused: false } })

    const set = (time: string) => notificationsProcess.execute(new UpdateNotificationSettingsOperation({ userId: user.id, time }))
    expect(await set('21:30')).toMatchObject({ success: true, settings: { moodReminderTime: '21:30' } })
    for (const bad of ['07:30', '23:00', '20:15', '8:00', 'вечером']) {
      expect(await set(bad)).toEqual({ success: false, error: NotificationsOperationErrorCode.INVALID_TIME })
    }
  })

  it('«Не нужно» выключает напоминание и больше не спрашивает', async () => {
    const user = await registerConfirmedUser()
    const result = await notificationsProcess.execute(
      new UpdateNotificationSettingsOperation({ userId: user.id, enabled: false, offerAnswered: true }),
    )
    expect(result).toMatchObject({ settings: { moodReminderEnabled: false, offerAnswered: true } })
  })

  it('подписка Web Push принимает только https-адрес с ключами; Telegram — только привязанному аккаунту', async () => {
    const user = await registerConfirmedUser()
    const create = (over: object) =>
      notificationsProcess.execute(new CreateSubscriptionOperation({ userId: user.id, channel: 'web_push', ...over }))
    expect(await create({ endpoint: 'http://push.example/x', p256dh: 'p', auth: 'a' })).toEqual({
      success: false,
      error: NotificationsOperationErrorCode.INVALID_SUBSCRIPTION,
    })
    expect(await create({ endpoint: 'https://push.example/x' })).toMatchObject({ success: false })
    expect(
      await notificationsProcess.execute(new CreateSubscriptionOperation({ userId: user.id, channel: 'telegram' })),
    ).toEqual({ success: false, error: NotificationsOperationErrorCode.TELEGRAM_NOT_LINKED })
  })
})

describe('правила отправки', () => {
  it('в 20:00 по местному времени уходит одно напоминание; повторный тик и вторая реплика ничего не добавляют', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    expect(await tick(EVENING)).toMatchObject({ sent: 1 })
    expect(sent).toHaveLength(1)
    // Two replicas at once, then the next minute: still one.
    await Promise.all([tick(EVENING), tick(EVENING)])
    await tick(new Date(EVENING.getTime() + 60_000))
    expect(sent).toHaveLength(1)
    const rows = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, user.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'mood', localDate: LOCAL_DATE, error: null })
  })

  it('уже отметился в 18:00 — в 20:00 напоминания нет', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    await getDb().insert(moodCheckins).values({ userId: user.id, localDate: LOCAL_DATE, mood: 3, source: 'app' })
    expect(await tick(EVENING)).toMatchObject({ sent: 0 })
    expect(sent).toHaveLength(0)
  })

  it('до времени напоминания и позже чем на 2 часа после него (сервер лежал) напоминания нет', async () => {
    const sent = fakeTransport()
    await personWithPush()
    expect(await tick(new Date('2026-10-24T16:55:00Z'))).toMatchObject({ sent: 0 }) // 19:55
    expect(await tick(new Date('2026-10-24T19:15:00Z'))).toMatchObject({ sent: 0 }) // 22:15, down since 19:30
    expect(sent).toHaveLength(0)
  })

  it('не раньше 08:00 и не позже 23:00 по местному времени, даже если время выбрано на краю', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    await notificationsProcess.execute(new UpdateNotificationSettingsOperation({ userId: user.id, time: '22:30' }))
    expect(await tick(new Date('2026-10-24T19:35:00Z'))).toMatchObject({ sent: 1 }) // 22:35, window ends at 23:00
    expect(sent).toHaveLength(1)
    await getDb().delete(notificationDeliveries)
    expect(await tick(new Date('2026-10-24T20:05:00Z'))).toMatchObject({ sent: 0 }) // 23:05
  })

  it('в часовом поясе человека: во Владивостоке 20:00 наступает на семь часов раньше московского', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    await getDb().update(users).set({ timezone: 'Asia/Vladivostok' }).where(eq(users.id, user.id))
    expect(await tick(new Date('2026-10-24T10:05:00Z'))).toMatchObject({ sent: 1 }) // 20:05 in Vladivostok
    expect(sent).toHaveLength(1)
  })

  it('выключено — не отправляется', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    await notificationsProcess.execute(new UpdateNotificationSettingsOperation({ userId: user.id, enabled: false }))
    await tick(EVENING)
    expect(sent).toHaveLength(0)
  })

  it('текст — из набора бережных фраз, без счёта дней и упрёков', async () => {
    const sent = fakeTransport()
    await personWithPush()
    await tick(EVENING)
    expect(sent[0]?.text).toMatch(/\?|—|минут/u)
    expect(sent[0]?.text).not.toMatch(/\d|пропустил|не отмечал|снова/u)
  })
})

describe('адреса и доставка', () => {
  it('ответ 404/410 от push-сервиса удаляет подписку; доставка помечена ошибкой', async () => {
    fakeTransport({ ok: false, gone: true, error: 'push_410' })
    const { user, subscriptionId } = await personWithPush()
    await tick(EVENING)
    const left = await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptionId))
    expect(left).toEqual([])
    const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, user.id))
    expect(delivery?.error).toBe('push_410')
  })

  it('временный сбой подписку не удаляет, но считается', async () => {
    fakeTransport({ ok: false, gone: false, error: 'push_500' })
    const { subscriptionId } = await personWithPush()
    await tick(EVENING)
    const [sub] = await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptionId))
    expect(sub?.failures).toBe(1)
  })

  it('бот Telegram: сообщение уходит тому, кто привязал аккаунт и разрешил писать', async () => {
    const sent = fakeTransport()
    const user = await registerConfirmedUser()
    await getDb().update(users).set({ telegramId: 777001 }).where(eq(users.id, user.id))
    const created = await notificationsProcess.execute(new CreateSubscriptionOperation({ userId: user.id, channel: 'telegram' }))
    expect(created.success).toBe(true)
    await tick(EVENING)
    expect(sent).toEqual([expect.objectContaining({ kind: 'telegram', target: '777001' })])
  })
})

describe('пауза при неоткрытых', () => {
  async function pastDeliveries(userId: string, count: number, opened: number[] = []) {
    for (let i = 0; i < count; i += 1) {
      const day = new Date(Date.UTC(2026, 9, 24 - count + i))
      await getDb().insert(notificationDeliveries).values({
        userId,
        kind: 'mood',
        localDate: day.toISOString().slice(0, 10),
        channel: 'web_push',
        sentAt: new Date(day.getTime() + 17 * 3600_000),
        openedAt: opened.includes(i) ? new Date(day.getTime() + 18 * 3600_000) : null,
      })
    }
  }

  it('после семи неоткрытых подряд восьмого нет, и дневник видит паузу', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    await pastDeliveries(user.id, 7)
    expect(await tick(EVENING)).toMatchObject({ sent: 0, paused: 1 })
    expect(sent).toHaveLength(0)
    const settings = await notificationsProcess.execute(new GetNotificationSettingsOperation({ userId: user.id }))
    expect(settings).toMatchObject({ settings: { paused: true } })
    // Paused people are not even candidates any more.
    expect(await tick(new Date(EVENING.getTime() + 60_000))).toMatchObject({ sent: 0, paused: 0 })
  })

  it('шесть неоткрытых и одно открытое — пауза не наступает', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    await pastDeliveries(user.id, 7, [6])
    expect(await tick(EVENING)).toMatchObject({ sent: 1, paused: 0 })
    expect(sent).toHaveLength(1)
  })

  it('«Вернуть» снимает паузу, и старые неоткрытые заново не ставят её', async () => {
    const sent = fakeTransport()
    const { user } = await personWithPush()
    await pastDeliveries(user.id, 7)
    await tick(EVENING)
    const resumed = await notificationsProcess.execute(new UpdateNotificationSettingsOperation({ userId: user.id, enabled: true }))
    expect(resumed).toMatchObject({ settings: { paused: false } })
    expect(await tick(new Date(EVENING.getTime() + 60_000))).toMatchObject({ sent: 1, paused: 0 })
    expect(sent).toHaveLength(1)
  })

  it('открытие напоминания записывается и будит напоминание', async () => {
    fakeTransport()
    const { user } = await personWithPush()
    await tick(EVENING)
    const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, user.id))
    await getDb().insert(notificationSettings).values({ userId: user.id, pausedAt: new Date() }).onConflictDoNothing()
    await notificationsProcess.execute(new MarkReminderOpenedOperation({ userId: user.id, deliveryId: delivery!.id }))
    const [after] = await getDb().select().from(notificationDeliveries).where(and(eq(notificationDeliveries.id, delivery!.id)))
    expect(after?.openedAt).not.toBeNull()
    expect(await notificationsProcess.execute(new GetNotificationSettingsOperation({ userId: user.id }))).toMatchObject({
      settings: { paused: false },
    })
  })
})
