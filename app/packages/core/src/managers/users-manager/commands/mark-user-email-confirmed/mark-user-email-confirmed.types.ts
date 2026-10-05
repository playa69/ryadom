export enum MarkUserEmailConfirmedCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type MarkUserEmailConfirmedCommandResult =
  { success: true } | { success: false; error: MarkUserEmailConfirmedCommandErrorCode }
