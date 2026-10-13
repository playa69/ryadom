/**
 * Whose traffic an account is (`users.properties.traffic_type`): `real` people, `test` (load tests, scripted
 * checks) or `internal` (the team). Product analytics tags every event of the account with it, so a figure can
 * leave out what is not people and the raw log shows which accounts are not counted.
 */
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { users } from '@ryadom/db/schema'
import { getDb } from '../src/shared'
import {
  ANALYTICS_PREFS_KEY,
  GetUserByIdQuery,
  SetUserAnalyticsOptOutCommand,
  SetUserTrafficTypeCommand,
  SetUserTrafficTypeCommandErrorCode,
  usersManager,
  type TrafficType,
} from '../src/managers/users-manager'
import { getUserRow, registerConfirmedUser } from './helpers'

const setTraffic = (userId: string, trafficType: TrafficType) =>
  usersManager.execute(new SetUserTrafficTypeCommand({ userId, trafficType }))

async function trafficOf(userId: string): Promise<TrafficType> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) throw new Error('user not found')
  return found.user.trafficType
}

describe('тип трафика аккаунта', () => {
  it('по умолчанию аккаунт обычный; пометка записывается и снимается', async () => {
    const user = await registerConfirmedUser()
    expect(await trafficOf(user.id)).toBe('real')

    expect(await setTraffic(user.id, 'test')).toEqual({ success: true })
    expect(await trafficOf(user.id)).toBe('test')

    expect(await setTraffic(user.id, 'internal')).toEqual({ success: true })
    expect(await trafficOf(user.id)).toBe('internal')

    expect(await setTraffic(user.id, 'real')).toEqual({ success: true })
    expect(await trafficOf(user.id)).toBe('real')
    // «real» — это отсутствие ключа, а не строка в базе.
    expect((await getUserRow(user.id))?.properties).not.toHaveProperty('traffic_type')
  })

  it('не стирается, когда человек сохраняет выбор по аналитике, и сам его не стирает', async () => {
    const user = await registerConfirmedUser()
    await setTraffic(user.id, 'test')

    // Выбор человека заменяет весь объект analytics: пометка лежит рядом с ним, а не внутри.
    await usersManager.execute(new SetUserAnalyticsOptOutCommand({ userId: user.id, optOut: true }))
    expect(await trafficOf(user.id)).toBe('test')
    expect((await getUserRow(user.id))?.properties).toMatchObject({ [ANALYTICS_PREFS_KEY]: { optOut: true } })

    await setTraffic(user.id, 'internal')
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: user.id }))
    expect(found.success && found.user.analyticsOptOut).toBe(true)
  })

  it('значение вне набора, оказавшееся в базе, читается как обычный аккаунт', async () => {
    const user = await registerConfirmedUser()
    // Руками в базе: пометка, которой нет среди допустимых, не должна давать произвольный тег в отчётах.
    await getDb()
      .update(users)
      .set({ properties: sql`'{"traffic_type": "bot-farm"}'::jsonb` })
      .where(eq(users.id, user.id))
    expect(await trafficOf(user.id)).toBe('real')
  })

  it('отказывает неизвестному аккаунту', async () => {
    expect(await setTraffic('00000000-0000-4000-8000-000000000000', 'test')).toEqual({
      success: false,
      error: SetUserTrafficTypeCommandErrorCode.USER_NOT_FOUND,
    })
    expect(await setTraffic('not-a-uuid', 'test')).toEqual({
      success: false,
      error: SetUserTrafficTypeCommandErrorCode.USER_NOT_FOUND,
    })
  })
})
