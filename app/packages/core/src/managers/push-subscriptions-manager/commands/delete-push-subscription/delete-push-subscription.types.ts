export enum DeletePushSubscriptionCommandErrorCode {
  /** No such subscription (of this account): somebody else's id reads the same as one that never existed. */
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
}

export type DeletePushSubscriptionCommandResult =
  { success: true } | { success: false; error: DeletePushSubscriptionCommandErrorCode }
