import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diaryManager, ListDiarySummariesQuery } from '../../../managers/diary-manager'
import { GetNotificationSettingsQuery, notificationsManager } from '../../../managers/notifications-manager'
import { addDaysToDate, localMoment, weekStart } from '../../../shared'
import { userZone } from '../shared/user-zone'
import { checkinsBetween } from '../shared/digests'
import { GetDiaryOperation } from './get-diary.operation'
import { GetDiaryOperationErrorCode, type GetDiaryResult } from './get-diary.types'

@requestHandler(GetDiaryOperation)
export class GetDiaryOperationHandler implements RequestHandler<GetDiaryOperation, GetDiaryResult> {
  async handle(c: GetDiaryOperation): Promise<GetDiaryResult> {
    const now = c.now ?? new Date()
    const zone = await userZone(c.userId)
    if (!zone) return { success: false, error: GetDiaryOperationErrorCode.USER_NOT_FOUND }
    const local = localMoment(now, zone)
    const month = c.month ?? local.date.slice(0, 7)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { success: false, error: GetDiaryOperationErrorCode.INVALID_MONTH }
    const [y, m] = month.split('-').map(Number) as [number, number]
    const lastDay = String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')
    const start = weekStart(local.date)
    const [monthDays, weekDays, summaries, settings] = await Promise.all([
      checkinsBetween(c.userId, `${month}-01`, `${month}-${lastDay}`),
      checkinsBetween(c.userId, start, addDaysToDate(start, 6)),
      diaryManager.execute(new ListDiarySummariesQuery({ userId: c.userId, kind: 'week', from: start, to: start, limit: 1 })),
      notificationsManager.execute(new GetNotificationSettingsQuery({ userId: c.userId })),
    ])
    return {
      success: true,
      diary: {
        today: weekDays.find((d) => d.date === local.date) ?? null,
        month: monthDays,
        week: { start, markedDays: weekDays.length, summary: summaries.summaries[0] ?? null },
        reminder: {
          enabled: settings.settings.moodReminderEnabled,
          time: settings.settings.moodReminderTime,
          paused: settings.settings.paused,
          offerAnswered: settings.settings.offerAnswered,
        },
      },
    }
  }
}
