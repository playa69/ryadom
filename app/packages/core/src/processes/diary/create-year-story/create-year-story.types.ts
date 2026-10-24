import type { DiarySummaryDTO } from '../../../managers/diary-manager'
export enum CreateYearStoryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  NOT_ENOUGH_WEEKS = 'NOT_ENOUGH_WEEKS',
  SUMMARY_UNAVAILABLE = 'SUMMARY_UNAVAILABLE',
}

export type CreateYearStoryResult =
  | { success: true; summary: DiarySummaryDTO }
  | { success: false; error: CreateYearStoryOperationErrorCode }
