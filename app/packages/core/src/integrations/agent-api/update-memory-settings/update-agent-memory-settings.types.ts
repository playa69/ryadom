import type { AgentMemorySettingsResponse } from '../shared/agent-memory.types'

export enum UpdateAgentMemorySettingsRequestErrorCode {
  /** `MEMORY_UNAVAILABLE` (503): the memory storage of the agent is not ready, memory cannot be turned on now. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** `MEMORY_NOT_ALLOWED` (403): a closed beta, and this person is not in it. */
  MEMORY_NOT_ALLOWED = 'MEMORY_NOT_ALLOWED',
  /** `AGENT_VALIDATION`: the agent did not accept the request as we sent it. */
  INVALID_REQUEST = 'INVALID_REQUEST',
}

export type UpdateAgentMemorySettingsResult =
  | { success: true; settings: AgentMemorySettingsResponse }
  | { success: false; error: UpdateAgentMemorySettingsRequestErrorCode }
