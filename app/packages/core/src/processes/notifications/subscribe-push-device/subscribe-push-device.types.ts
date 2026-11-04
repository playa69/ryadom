export enum SubscribePushDeviceOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

/** The id stays the same for the same token, so a device that subscribes again keeps the id it remembered. */
export type SubscribePushDeviceResult =
  { success: true; subscriptionId: string } | { success: false; error: SubscribePushDeviceOperationErrorCode }
