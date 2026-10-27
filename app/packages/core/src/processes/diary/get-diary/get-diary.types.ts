import type { DiarySummaryDTO, MoodCheckinDTO } from '../../../managers/diary-manager'
/** What the diary screen shows: today's note, the last 28 days, the streak, the week and the final summary of the last one. */
export interface DiaryView {
  today: MoodCheckinDTO | null
  /** Marks of the last 28 days including today: the window of the mood chart. */
  recent: MoodCheckinDTO[]
  /** Consecutive marked days ending today (or yesterday while today is not marked). */
  streak: number
  week: { start: string; markedDays: number; summary: DiarySummaryDTO | null }
  /** The final summary of the last finished local week (made by the scheduler), if it has one. */
  previousWeek: DiarySummaryDTO | null
}

export enum GetDiaryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetDiaryResult =
  | { success: true; diary: DiaryView }
  | { success: false; error: GetDiaryOperationErrorCode }
