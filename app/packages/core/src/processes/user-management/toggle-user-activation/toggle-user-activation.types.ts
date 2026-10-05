export enum ToggleUserActivationOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_DELETED = 'USER_DELETED',
}

export type ToggleUserActivationResult =
  { success: true; isActive: boolean } | { success: false; error: ToggleUserActivationOperationErrorCode }
