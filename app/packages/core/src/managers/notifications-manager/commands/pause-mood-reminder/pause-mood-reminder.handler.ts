import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { notificationSettings } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { PauseMoodReminderCommand } from './pause-mood-reminder.command'
import { type PauseMoodReminderCommandResult } from './pause-mood-reminder.types'

@requestHandler(PauseMoodReminderCommand)
export class PauseMoodReminderCommandHandler implements RequestHandler<PauseMoodReminderCommand, PauseMoodReminderCommandResult> {
  async handle(c: PauseMoodReminderCommand): Promise<PauseMoodReminderCommandResult> {
    const now = new Date()
    await getDb()
      .insert(notificationSettings)
      .values({ userId: c.userId, pausedAt: now })
      .onConflictDoUpdate({ target: notificationSettings.userId, set: { pausedAt: now, updatedAt: now } })
    return { success: true }
  }
}
