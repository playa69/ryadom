export enum SoftDeleteUserCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  ALREADY_DELETED = 'ALREADY_DELETED',
}

export type SoftDeleteUserCommandResult =
  { success: true } | { success: false; error: SoftDeleteUserCommandErrorCode }
