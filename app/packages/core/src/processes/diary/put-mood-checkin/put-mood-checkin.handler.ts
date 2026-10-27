import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diaryManager, GetMoodCheckinQuery, UpsertMoodCheckinCommand } from '../../../managers/diary-manager'
import { addDaysToDate, isValidDate, localMoment } from '../../../shared'
import { userZone } from '../shared/user-zone'
import { hardStreakEnding } from '../shared/hard-streak'
import { PutMoodCheckinOperation } from './put-mood-checkin.operation'
import { PutMoodCheckinOperationErrorCode, type PutMoodCheckinResult } from './put-mood-checkin.types'

@requestHandler(PutMoodCheckinOperation)
export class PutMoodCheckinOperationHandler implements RequestHandler<PutMoodCheckinOperation, PutMoodCheckinResult> {
  async handle(c: PutMoodCheckinOperation): Promise<PutMoodCheckinResult> {
    const zone = await userZone(c.userId)
    if (!zone) return { success: false, error: PutMoodCheckinOperationErrorCode.USER_NOT_FOUND }
    const today = localMoment(c.now ?? new Date(), zone).date
    // Only today counts; yesterday is allowed for a note queued without network (design D2, D5).
    const localDate = c.date ?? today
    if (!isValidDate(localDate) || (localDate !== today && localDate !== addDaysToDate(today, -1))) {
      return { success: false, error: PutMoodCheckinOperationErrorCode.DATE_OUT_OF_RANGE }
    }
    const before = await diaryManager.execute(new GetMoodCheckinQuery({ userId: c.userId, localDate }))
    await diaryManager.execute(
      new UpsertMoodCheckinCommand({ userId: c.userId, localDate, mood: c.mood, factor: c.factor, source: c.source }),
    )
    const after = await diaryManager.execute(new GetMoodCheckinQuery({ userId: c.userId, localDate }))
    if (!after.checkin) throw new Error('A note that was just written is not there')
    const hardStreak = after.checkin.mood === 1 ? await hardStreakEnding(c.userId, localDate) : 0
    return { success: true, checkin: after.checkin, changed: before.checkin !== null, hardStreak }
  }
}
