import type { DiarySummaryDTO } from '../../../managers/diary-manager'
export enum CreateWeekSummaryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  DATE_OUT_OF_RANGE = 'DATE_OUT_OF_RANGE',
  NOT_ENOUGH_DAYS = 'NOT_ENOUGH_DAYS',
  TOO_SOON = 'TOO_SOON',
  SUMMARY_UNAVAILABLE = 'SUMMARY_UNAVAILABLE',
}

export type CreateWeekSummaryResult =
  | { success: true; summary: DiarySummaryDTO }
  | { success: false; error: CreateWeekSummaryOperationErrorCode }
