import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { notificationSettings, pushSubscriptions, users, type PushChannel } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DEFAULT_REMINDER_TIME, toHHmm } from '../../shared/notifications.dto'
import { ListReminderCandidatesQuery } from './list-reminder-candidates.query'
import { type ListReminderCandidatesQueryResult } from './list-reminder-candidates.types'

@requestHandler(ListReminderCandidatesQuery)
export class ListReminderCandidatesQueryHandler implements RequestHandler<ListReminderCandidatesQuery, ListReminderCandidatesQueryResult> {
  async handle(c: ListReminderCandidatesQuery): Promise<ListReminderCandidatesQueryResult> {
    // People with a server-side channel and an enabled, not paused reminder; the scheduler filters by local time.
    const rows = await getDb()
      .selectDistinct({
        userId: users.id,
        timezone: users.timezone,
        telegramId: users.telegramId,
        time: notificationSettings.moodReminderTime,
        streakResetAt: notificationSettings.streakResetAt,
      })
      .from(users)
      .innerJoin(
        pushSubscriptions,
        and(eq(pushSubscriptions.userId, users.id), inArray(pushSubscriptions.channel, ['web_push', 'telegram'] as PushChannel[])),
      )
      .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
      .where(
        and(
          eq(users.isActive, true),
          eq(users.isDeleted, false),
          or(isNull(notificationSettings.moodReminderEnabled), eq(notificationSettings.moodReminderEnabled, true)),
          isNull(notificationSettings.pausedAt),
          c.afterUserId ? gt(users.id, c.afterUserId) : undefined,
        ),
      )
      .orderBy(asc(users.id))
      .limit(c.limit)
    return {
      success: true,
      candidates: rows.map((r) => ({
        userId: r.userId,
        timezone: r.timezone,
        telegramId: r.telegramId,
        time: toHHmm(r.time ?? DEFAULT_REMINDER_TIME),
        streakResetAt: r.streakResetAt,
      })),
    }
  }
}
