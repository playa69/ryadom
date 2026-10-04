export enum SetUserActiveCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_DELETED = 'USER_DELETED',
}

export type SetUserActiveCommandResult =
  { success: true } | { success: false; error: SetUserActiveCommandErrorCode }
