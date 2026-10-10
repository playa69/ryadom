export enum SetUserAnalyticsOptOutCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type SetUserAnalyticsOptOutCommandResult =
  { success: true } | { success: false; error: SetUserAnalyticsOptOutCommandErrorCode }
