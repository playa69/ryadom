export enum DeletePushSubscriptionCommandErrorCode {
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
}

export type DeletePushSubscriptionCommandResult =
  | { success: true }
  | { success: false; error: DeletePushSubscriptionCommandErrorCode }
