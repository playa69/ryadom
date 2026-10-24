export enum DeleteSubscriptionOperationErrorCode {
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
}

export type DeleteSubscriptionResult =
  | { success: true }
  | { success: false; error: DeleteSubscriptionOperationErrorCode }
