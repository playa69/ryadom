export enum RevokeUserSessionCommandErrorCode {
  /** No live session with this id belongs to the user. Someone else's session looks the same as a missing one. */
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
}

export type RevokeUserSessionCommandResult =
  { success: true } | { success: false; error: RevokeUserSessionCommandErrorCode }
