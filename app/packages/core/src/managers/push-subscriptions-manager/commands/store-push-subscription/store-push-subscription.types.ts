export enum StorePushSubscriptionCommandErrorCode {
  /** The account is gone (deleted a moment ago): there is nobody to subscribe. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type StorePushSubscriptionCommandResult =
  { success: true } | { success: false; error: StorePushSubscriptionCommandErrorCode }
