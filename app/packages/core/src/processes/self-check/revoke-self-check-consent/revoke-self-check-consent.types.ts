export enum RevokeSelfCheckConsentOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type RevokeSelfCheckConsentResult =
  { success: true; deleted: number } | { success: false; error: RevokeSelfCheckConsentOperationErrorCode }
