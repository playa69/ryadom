export enum SetUserTrafficTypeCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type SetUserTrafficTypeCommandResult =
  { success: true } | { success: false; error: SetUserTrafficTypeCommandErrorCode }
