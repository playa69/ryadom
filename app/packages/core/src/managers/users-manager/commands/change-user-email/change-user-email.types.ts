export enum ChangeUserEmailCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  EMAIL_ALREADY_TAKEN = 'EMAIL_ALREADY_TAKEN',
}

export type ChangeUserEmailCommandResult =
  { success: true } | { success: false; error: ChangeUserEmailCommandErrorCode }
