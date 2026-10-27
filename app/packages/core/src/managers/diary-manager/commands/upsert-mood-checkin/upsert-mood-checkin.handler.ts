import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { moodCheckins } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { UpsertMoodCheckinCommand } from './upsert-mood-checkin.command'
import { type UpsertMoodCheckinCommandResult } from './upsert-mood-checkin.types'

@requestHandler(UpsertMoodCheckinCommand)
export class UpsertMoodCheckinCommandHandler implements RequestHandler<UpsertMoodCheckinCommand, UpsertMoodCheckinCommandResult> {
  async handle(c: UpsertMoodCheckinCommand): Promise<UpsertMoodCheckinCommandResult> {
    // One note per local day: a second one replaces the first; the factor stays unless the command names one.
    await getDb()
      .insert(moodCheckins)
      .values({ userId: c.userId, localDate: c.localDate, mood: c.mood, factor: c.factor ?? null, source: c.source })
      .onConflictDoUpdate({
        target: [moodCheckins.userId, moodCheckins.localDate],
        set: {
          mood: c.mood,
          source: c.source,
          updatedAt: new Date(),
          ...(c.factor === undefined ? {} : { factor: c.factor }),
        },
      })
    return { success: true }
  }
}
