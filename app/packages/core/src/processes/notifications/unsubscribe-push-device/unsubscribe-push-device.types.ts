export enum UnsubscribePushDeviceOperationErrorCode {
  /** None of the person's subscriptions has this id. */
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
}

export type UnsubscribePushDeviceResult =
  { success: true } | { success: false; error: UnsubscribePushDeviceOperationErrorCode }
