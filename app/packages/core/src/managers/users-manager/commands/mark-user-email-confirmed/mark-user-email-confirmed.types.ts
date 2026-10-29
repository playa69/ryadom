export enum MarkUserEmailConfirmedCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The account holds another address now (or none): the address that was proven is not its own any more. */
  EMAIL_MISMATCH = 'EMAIL_MISMATCH',
}

export type MarkUserEmailConfirmedCommandResult =
  { success: true } | { success: false; error: MarkUserEmailConfirmedCommandErrorCode }
