export enum GetUserDeletionArchiveQueryErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetUserDeletionArchiveQueryResult =
  { success: true; archive: Record<string, unknown> | null } | { success: false; error: GetUserDeletionArchiveQueryErrorCode }
