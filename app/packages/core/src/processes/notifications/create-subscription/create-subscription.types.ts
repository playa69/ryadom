export enum CreateSubscriptionOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_SUBSCRIPTION = 'INVALID_SUBSCRIPTION',
  TELEGRAM_NOT_LINKED = 'TELEGRAM_NOT_LINKED',
}

export type CreateSubscriptionResult =
  | { success: true; id: string }
  | { success: false; error: CreateSubscriptionOperationErrorCode }
