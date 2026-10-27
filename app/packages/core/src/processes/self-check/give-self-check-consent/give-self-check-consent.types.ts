export enum GiveSelfCheckConsentOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GiveSelfCheckConsentResult =
  { success: true; version: string } | { success: false; error: GiveSelfCheckConsentOperationErrorCode }
