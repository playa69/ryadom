export enum UpdateUserTimezoneCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type UpdateUserTimezoneCommandResult =
  { success: true } | { success: false; error: UpdateUserTimezoneCommandErrorCode }
