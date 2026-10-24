import type { DiarySummaryDTO, MoodCheckinDTO } from '../../../managers/diary-manager'
export interface ReminderState {
  enabled: boolean
  time: string
  paused: boolean
  offerAnswered: boolean
}

/** What the diary screen shows: today's note, the month, the week and the reminder setting. */
export interface DiaryView {
  today: MoodCheckinDTO | null
  month: MoodCheckinDTO[]
  week: { start: string; markedDays: number; summary: DiarySummaryDTO | null }
  reminder: ReminderState
}

export enum GetDiaryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_MONTH = 'INVALID_MONTH',
}

export type GetDiaryResult =
  | { success: true; diary: DiaryView }
  | { success: false; error: GetDiaryOperationErrorCode }
