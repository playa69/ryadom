export enum RecapDialogOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type RecapDialogResult =
  /** The recap is the person's conversation retold, so personal data: it is returned, never logged or stored here. */
  { success: true; recap: string | null } | { success: false; error: RecapDialogOperationErrorCode }
