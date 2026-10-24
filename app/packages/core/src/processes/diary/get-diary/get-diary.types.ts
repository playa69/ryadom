import type { DiarySummaryDTO, MoodCheckinDTO } from '../../../managers/diary-manager'
/** What the diary screen shows: today's note, the month, the week. */
export interface DiaryView {
  today: MoodCheckinDTO | null
  month: MoodCheckinDTO[]
  week: { start: string; markedDays: number; summary: DiarySummaryDTO | null }
}

export enum GetDiaryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_MONTH = 'INVALID_MONTH',
}

export type GetDiaryResult =
  | { success: true; diary: DiaryView }
  | { success: false; error: GetDiaryOperationErrorCode }
