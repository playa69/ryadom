export enum GetSelfCheckConsentOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetSelfCheckConsentResult =
  { success: true; version: string | null } | { success: false; error: GetSelfCheckConsentOperationErrorCode }
