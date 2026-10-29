export enum PutDialogSettingsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}

export type PutDialogSettingsResult =
  | { success: true; recapEnabled: boolean }
  | { success: false; error: PutDialogSettingsOperationErrorCode }
