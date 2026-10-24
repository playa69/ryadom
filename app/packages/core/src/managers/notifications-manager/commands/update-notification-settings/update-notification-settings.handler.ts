import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { notificationSettings } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { UpdateNotificationSettingsCommand } from './update-notification-settings.command'
import { type UpdateNotificationSettingsCommandResult } from './update-notification-settings.types'

@requestHandler(UpdateNotificationSettingsCommand)
export class UpdateNotificationSettingsCommandHandler implements RequestHandler<UpdateNotificationSettingsCommand, UpdateNotificationSettingsCommandResult> {
  async handle(c: UpdateNotificationSettingsCommand): Promise<UpdateNotificationSettingsCommandResult> {
    // Only the fields sent change. Switching the reminder on wakes a paused one: «Return» is the same call.
    const now = new Date()
    const set: Partial<typeof notificationSettings.$inferInsert> = { updatedAt: now }
    if (c.enabled !== undefined) set.moodReminderEnabled = c.enabled
    if (c.time !== undefined) set.moodReminderTime = c.time
    if (c.offerAnswered) set.offerAnsweredAt = now
    if (c.enabled === true) {
      set.pausedAt = null
      set.streakResetAt = now
    }
    await getDb()
      .insert(notificationSettings)
      .values({ userId: c.userId, ...set })
      .onConflictDoUpdate({ target: notificationSettings.userId, set })
    return { success: true }
  }
}
