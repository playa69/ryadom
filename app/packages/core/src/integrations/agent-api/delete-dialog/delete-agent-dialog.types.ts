export enum DeleteAgentDialogRequestErrorCode {
  /** The agent answered 404: the dialog does not exist or belongs to someone else. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type DeleteAgentDialogResult = { success: true } | { success: false; error: DeleteAgentDialogRequestErrorCode }
