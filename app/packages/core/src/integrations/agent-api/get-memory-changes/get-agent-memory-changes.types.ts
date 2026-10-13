import type { AgentMemoryChangesResponse } from '../shared/agent-memory.types'

export enum GetAgentMemoryChangesRequestErrorCode {
  /** `AGENT_DIALOG_NOT_FOUND` (404): the dialog does not exist or belongs to someone else. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type GetAgentMemoryChangesResult =
  | { success: true; changes: AgentMemoryChangesResponse }
  | { success: false; error: GetAgentMemoryChangesRequestErrorCode }
