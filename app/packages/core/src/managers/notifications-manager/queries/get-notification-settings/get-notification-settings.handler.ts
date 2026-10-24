import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { notificationSettings } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DEFAULT_REMINDER_TIME, toHHmm } from '../../shared/notifications.dto'
import { GetNotificationSettingsQuery } from './get-notification-settings.query'
import { type GetNotificationSettingsQueryResult } from './get-notification-settings.types'

@requestHandler(GetNotificationSettingsQuery)
export class GetNotificationSettingsQueryHandler implements RequestHandler<GetNotificationSettingsQuery, GetNotificationSettingsQueryResult> {
  async handle(c: GetNotificationSettingsQuery): Promise<GetNotificationSettingsQueryResult> {
    // No row means the defaults: on, at 20:00.
    const [row] = await getDb().select().from(notificationSettings).where(eq(notificationSettings.userId, c.userId)).limit(1)
    return {
      success: true,
      settings: {
        moodReminderEnabled: row?.moodReminderEnabled ?? true,
        moodReminderTime: toHHmm(row?.moodReminderTime ?? DEFAULT_REMINDER_TIME),
        paused: Boolean(row?.pausedAt),
        offerAnswered: Boolean(row?.offerAnsweredAt),
      },
    }
  }
}
