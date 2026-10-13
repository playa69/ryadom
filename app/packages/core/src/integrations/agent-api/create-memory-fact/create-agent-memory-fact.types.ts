import type { AgentMemoryFactResponse } from '../shared/agent-memory.types'

export enum CreateAgentMemoryFactRequestErrorCode {
  /** `MEMORY_DISABLED` (409): the person's memory is off. */
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  /** `MEMORY_FULL` (409): no room for another fact. */
  MEMORY_FULL = 'MEMORY_FULL',
  /** `FACT_REJECTED` (422): the rules of what may be remembered refuse it; `reason` names the rule. */
  FACT_REJECTED = 'FACT_REJECTED',
  /** `MEMORY_UNAVAILABLE` (503): the feature is off on the agent. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** `AGENT_VALIDATION`: the agent did not accept the fact as we sent it (a field too long, a wrong shape). */
  INVALID_REQUEST = 'INVALID_REQUEST',
}

export type CreateAgentMemoryFactResult =
  | { success: true; fact: AgentMemoryFactResponse }
  | { success: false; error: CreateAgentMemoryFactRequestErrorCode.FACT_REJECTED; reason: string | null }
  | {
      success: false
      error: Exclude<
        CreateAgentMemoryFactRequestErrorCode,
        CreateAgentMemoryFactRequestErrorCode.FACT_REJECTED
      >
    }
