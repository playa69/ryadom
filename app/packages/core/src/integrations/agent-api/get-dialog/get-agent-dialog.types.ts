import type { AgentDialogResponse } from '../shared/agent-api.types'

export enum GetAgentDialogRequestErrorCode {
  /** The agent answered 404: the dialog does not exist or belongs to someone else. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type GetAgentDialogResult =
  | { success: true; dialog: AgentDialogResponse }
  | { success: false; error: GetAgentDialogRequestErrorCode }
