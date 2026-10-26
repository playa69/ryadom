import type { AgentMemoryNoteResponse } from '../shared/agent-memory.types'

export enum AgentMemoryInstructionRequestErrorCode {
  /** `MEMORY_DISABLED` (409): the person's memory is off, there is nothing to change. */
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  /** `MEMORY_UNAVAILABLE` (503): the agent has no model for it right now. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
}

/** What the agent did with the request: notes added and corrected, ids deleted, codes of the rules that refused something. */
export interface AgentMemoryInstructionChanges {
  added: AgentMemoryNoteResponse[]
  updated: AgentMemoryNoteResponse[]
  deleted: string[]
  blocked: string[]
}

export type AgentMemoryInstructionResult =
  | { success: true; changes: AgentMemoryInstructionChanges }
  | { success: false; error: AgentMemoryInstructionRequestErrorCode }
