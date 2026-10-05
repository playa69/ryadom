export enum SetUserDeletionArchiveCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type SetUserDeletionArchiveCommandResult =
  { success: true } | { success: false; error: SetUserDeletionArchiveCommandErrorCode }
