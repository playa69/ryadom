export enum DeleteSelfCheckResultsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type DeleteSelfCheckResultsResult =
  { success: true; deleted: number } | { success: false; error: DeleteSelfCheckResultsOperationErrorCode }
