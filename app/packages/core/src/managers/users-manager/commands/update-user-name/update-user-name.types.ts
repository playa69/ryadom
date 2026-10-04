export enum UpdateUserNameCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type UpdateUserNameCommandResult =
  { success: true } | { success: false; error: UpdateUserNameCommandErrorCode }
