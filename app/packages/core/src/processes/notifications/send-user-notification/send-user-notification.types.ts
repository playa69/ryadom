export enum SendUserNotificationOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** A deleted account has no devices and nobody to read it. */
  USER_DELETED = 'USER_DELETED',
}

/**
 * `sent` of `total` devices took the notification. `total` 0: the person has no device with notifications on in an
 * open session; `sent` 0 of more: the push service took none of them (a device it no longer knows is unsubscribed).
 */
export type SendUserNotificationResult =
  | { success: true; sent: number; total: number }
  | { success: false; error: SendUserNotificationOperationErrorCode }
