import type { DiarySummaryDTO } from '../../../managers/diary-manager'
export enum ListWeekSummariesOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type ListWeekSummariesResult =
  | { success: true; summaries: DiarySummaryDTO[]; nextBefore: string | null }
  | { success: false; error: ListWeekSummariesOperationErrorCode }
