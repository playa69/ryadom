export enum RevokeUserSessionsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_DELETED = 'USER_DELETED',
}

export type RevokeUserSessionsResult =
  { success: true } | { success: false; error: RevokeUserSessionsOperationErrorCode }
