export enum CountReplyCommandErrorCode {
  /** The account is gone (deleted a moment ago): there is nobody to count for. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type CountReplyCommandResult =
  { success: true } | { success: false; error: CountReplyCommandErrorCode }
