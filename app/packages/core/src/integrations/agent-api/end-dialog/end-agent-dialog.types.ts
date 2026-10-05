import type { AgentDialogSummaryResponse } from '../shared/agent-api.types'

export enum EndAgentDialogRequestErrorCode {
  /** The agent answered 404: the dialog does not exist or belongs to someone else. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type EndAgentDialogResult =
  | { success: true; summary: AgentDialogSummaryResponse | null }
  | { success: false; error: EndAgentDialogRequestErrorCode }
