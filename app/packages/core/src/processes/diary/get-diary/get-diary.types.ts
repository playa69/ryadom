import type { DiarySummaryDTO, MoodCheckinDTO } from '../../../managers/diary-manager'
/** What the diary screen shows: today's note, the month, the last 28 days, the streak, the week. */
export interface DiaryView {
  today: MoodCheckinDTO | null
  month: MoodCheckinDTO[]
  /** Marks of the last 28 days including today: the window of the mood chart. */
  recent: MoodCheckinDTO[]
  /** Consecutive marked days ending today (or yesterday while today is not marked). */
  streak: number
  week: { start: string; markedDays: number; summary: DiarySummaryDTO | null }
}

export enum GetDiaryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_MONTH = 'INVALID_MONTH',
}

export type GetDiaryResult =
  | { success: true; diary: DiaryView }
  | { success: false; error: GetDiaryOperationErrorCode }
