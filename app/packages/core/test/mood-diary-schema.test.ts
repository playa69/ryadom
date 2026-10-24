/**
 * Schema of the mood diary (`REQ-WELL-01`, migration `0009_mood_diary`): one note per local day,
 * values limited by the database itself, rows go with the account.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { moodCheckins, notificationDeliveries, users } from '@ryadom/db/schema'
import { getDb } from '../src/shared'
import { registerConfirmedUser } from './helpers'

const note = (userId: string, over: Partial<typeof moodCheckins.$inferInsert> = {}) => ({
  userId,
  localDate: '2026-03-01',
  mood: 3,
  source: 'app' as const,
  ...over,
})

describe('схема дневника настроения', () => {
  it('у аккаунта по умолчанию часовой пояс Europe/Moscow', async () => {
    const user = await registerConfirmedUser()
    const [row] = await getDb().select({ timezone: users.timezone }).from(users).where(eq(users.id, user.id))
    expect(row?.timezone).toBe('Europe/Moscow')
  })

  it('одна отметка на местный день; уровень 1–5, фактор и источник из списка', async () => {
    const user = await registerConfirmedUser()
    const db = getDb()
    await db.insert(moodCheckins).values(note(user.id))
    await expect(db.insert(moodCheckins).values(note(user.id, { mood: 4 }))).rejects.toThrow()
    await expect(db.insert(moodCheckins).values(note(user.id, { localDate: '2026-03-02', mood: 6 }))).rejects.toThrow()
    await expect(db.insert(moodCheckins).values(note(user.id, { localDate: '2026-03-03', mood: 0 }))).rejects.toThrow()
    await expect(
      db.insert(moodCheckins).values(note(user.id, { localDate: '2026-03-04', factor: 'weather' as never })),
    ).rejects.toThrow()
    await expect(
      db.insert(moodCheckins).values(note(user.id, { localDate: '2026-03-05', source: 'sms' as never })),
    ).rejects.toThrow()
    await db.insert(moodCheckins).values(note(user.id, { localDate: '2026-03-06', factor: 'sleep', source: 'widget' }))
  })

  it('одна доставка напоминания на человека, вид и день: вторая запись отклоняется', async () => {
    const user = await registerConfirmedUser()
    const db = getDb()
    const delivery = { userId: user.id, kind: 'mood', localDate: '2026-03-01', channel: 'web_push' }
    await db.insert(notificationDeliveries).values(delivery)
    await expect(db.insert(notificationDeliveries).values({ ...delivery, channel: 'telegram' })).rejects.toThrow()
  })

  it('строки дневника уходят вместе с аккаунтом (ON DELETE CASCADE)', async () => {
    const user = await registerConfirmedUser()
    const db = getDb()
    await db.insert(moodCheckins).values(note(user.id))
    await db.delete(users).where(eq(users.id, user.id))
    expect(await db.select().from(moodCheckins).where(eq(moodCheckins.userId, user.id))).toEqual([])
  })
})
