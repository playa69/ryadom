export enum RecapAgentDialogRequestErrorCode {
  /** The agent answered 404: the dialog does not exist or belongs to someone else. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type RecapAgentDialogResult =
  /** `recap` is null when the agent has none to give: a short talk, "without memory", a crisis, no model. */
  { success: true; recap: string | null } | { success: false; error: RecapAgentDialogRequestErrorCode }
