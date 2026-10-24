export enum CreateWidgetTokenOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type CreateWidgetTokenResult =
  | { success: true; token: string }
  | { success: false; error: CreateWidgetTokenOperationErrorCode }
