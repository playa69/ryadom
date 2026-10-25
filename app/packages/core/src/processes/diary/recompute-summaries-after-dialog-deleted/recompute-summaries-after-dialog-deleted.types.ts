export enum RecomputeSummariesAfterDialogDeletedOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

/**
 * `weekDeleted` / `yearDeleted`: a text was removed. `scheduled`: a rebuild marker was left for the week
 * (only for a finished week; the current week is rebuilt by the person's own button).
 */
export type RecomputeSummariesAfterDialogDeletedResult =
  | { success: true; weekDeleted: boolean; yearDeleted: boolean; scheduled: boolean }
  | { success: false; error: RecomputeSummariesAfterDialogDeletedOperationErrorCode }
