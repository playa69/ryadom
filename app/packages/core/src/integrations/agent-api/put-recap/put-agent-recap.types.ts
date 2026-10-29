import type { AgentDialogSummaryResponse } from '../shared/agent-api.types'

export enum PutAgentRecapRequestErrorCode {
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
  /** Not saved, crisis, too short or not ended: no recap for this conversation. */
  RECAP_NOT_AVAILABLE = 'RECAP_NOT_AVAILABLE',
}

export type PutAgentRecapResult =
  | { success: true; summary: AgentDialogSummaryResponse | null }
  | { success: false; error: PutAgentRecapRequestErrorCode }
