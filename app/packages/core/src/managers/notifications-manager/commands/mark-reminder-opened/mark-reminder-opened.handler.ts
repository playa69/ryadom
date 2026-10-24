import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull } from 'drizzle-orm'
import { notificationDeliveries, notificationSettings } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { MarkReminderOpenedCommand } from './mark-reminder-opened.command'
import { MarkReminderOpenedCommandErrorCode, type MarkReminderOpenedCommandResult } from './mark-reminder-opened.types'

@requestHandler(MarkReminderOpenedCommand)
export class MarkReminderOpenedCommandHandler implements RequestHandler<MarkReminderOpenedCommand, MarkReminderOpenedCommandResult> {
  async handle(c: MarkReminderOpenedCommand): Promise<MarkReminderOpenedCommandResult> {
    // The person opened the app from a reminder: `opened_at`, and a paused reminder wakes up.
    const db = getDb()
    const rows = await db
      .update(notificationDeliveries)
      .set({ openedAt: new Date() })
      .where(
        and(
          eq(notificationDeliveries.id, c.deliveryId),
          eq(notificationDeliveries.userId, c.userId),
          isNull(notificationDeliveries.openedAt),
        ),
      )
      .returning({ id: notificationDeliveries.id })
    if (rows.length === 0) return { success: false, error: MarkReminderOpenedCommandErrorCode.DELIVERY_NOT_FOUND }
    await db
      .update(notificationSettings)
      .set({ pausedAt: null, streakResetAt: new Date() })
      .where(eq(notificationSettings.userId, c.userId))
    return { success: true }
  }
}
