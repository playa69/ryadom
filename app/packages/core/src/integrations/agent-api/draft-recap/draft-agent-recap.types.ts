import type { AgentRecapResponse } from '../shared/agent-api.types'

export enum DraftAgentRecapRequestErrorCode {
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
  /** Not saved, crisis or too short: no recap for this conversation. */
  RECAP_NOT_AVAILABLE = 'RECAP_NOT_AVAILABLE',
  /** The model did not write a draft. */
  UNAVAILABLE = 'UNAVAILABLE',
}

export type DraftAgentRecapResult =
  | { success: true; recap: AgentRecapResponse }
  | { success: false; error: DraftAgentRecapRequestErrorCode }
