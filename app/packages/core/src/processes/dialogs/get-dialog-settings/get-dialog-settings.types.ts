export enum GetDialogSettingsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}

export type GetDialogSettingsResult =
  | { success: true; recapEnabled: boolean }
  | { success: false; error: GetDialogSettingsOperationErrorCode }
