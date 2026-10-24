import type { MoodCheckinDTO } from '../../../managers/diary-manager'
export interface YearView {
  year: number
  days: MoodCheckinDTO[]
  markedDays: number
  mostFrequent: number | null
  /** Final week summaries of the year so far. */
  weeklyCount: number
  story: { text: string; generatedAt: Date; weeklyCount: number } | null
}

export enum GetYearOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  YEAR_OUT_OF_RANGE = 'YEAR_OUT_OF_RANGE',
}

export type GetYearResult =
  | { success: true; year: YearView }
  | { success: false; error: GetYearOperationErrorCode }
