/**
 * The count behind the Metrika goals `first_reply`, `polz_3` and `dau_10` (`openspec/changes/add-metrika-daily-goals`,
 * «Цели Метрики»): per account, per calendar day in Moscow, across dialogs and devices.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { userReplyCounts } from '@ryadom/db/schema'
import {
  CountReplyCommand,
  CountReplyCommandErrorCode,
  GetReplyCountQuery,
  replyCountsManager,
} from '../src/managers/reply-counts-manager'
import { getDb } from '../src/shared'
import { registerUser } from './helpers'

/** A reply at `at`, and what the count says after it: the day's number and whether it was the account's first. */
async function count(userId: string, at: string) {
  const moment = new Date(at)
  await replyCountsManager.execute(new CountReplyCommand({ userId, at: moment }))
  const { count: row } = await replyCountsManager.execute(new GetReplyCountQuery({ userId }))
  return { today: row?.replies, first: row?.firstReplyAt?.getTime() === moment.getTime() }
}

describe('count of accepted replies', () => {
  it('marks the first reply of an account and counts the day', async () => {
    const user = await registerUser()
    expect(await count(user.id, '2026-11-13T09:00:00Z')).toEqual({ today: 1, first: true })
    expect(await count(user.id, '2026-11-13T09:01:00Z')).toEqual({ today: 2, first: false })
    expect(await count(user.id, '2026-11-13T09:02:00Z')).toEqual({ today: 3, first: false })
  })

  it('starts the count over at midnight in Moscow, not in UTC', async () => {
    const user = await registerUser()
    // 20:59 UTC is 23:59 in Moscow; 21:00 UTC is already the next day there.
    expect(await count(user.id, '2026-11-13T20:58:00Z')).toMatchObject({ today: 1 })
    expect(await count(user.id, '2026-11-13T20:59:00Z')).toMatchObject({ today: 2 })
    expect(await count(user.id, '2026-11-13T21:00:00Z')).toEqual({ today: 1, first: false })
    expect(await count(user.id, '2026-11-13T23:00:00Z')).toMatchObject({ today: 2 })
  })

  it('does not take the next reply of an account from before the count for its first one', async () => {
    const user = await registerUser()
    // What the migration leaves for an account that existed before the table.
    await getDb().insert(userReplyCounts).values({ userId: user.id, day: '1970-01-01', replies: 0 })
    expect(await count(user.id, '2026-11-13T09:00:00Z')).toEqual({ today: 1, first: false })
  })

  it('refuses an account that does not exist', async () => {
    const result = await replyCountsManager.execute(
      new CountReplyCommand({ userId: randomUUID(), at: new Date() }),
    )
    expect(result).toEqual({ success: false, error: CountReplyCommandErrorCode.USER_NOT_FOUND })
  })
})
