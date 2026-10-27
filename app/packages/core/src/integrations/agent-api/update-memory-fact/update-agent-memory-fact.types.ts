import type { AgentMemoryFactResponse } from '../shared/agent-memory.types'

export enum UpdateAgentMemoryFactRequestErrorCode {
  /** `FACT_NOT_FOUND` (404): no such fact of this person. */
  FACT_NOT_FOUND = 'FACT_NOT_FOUND',
  /** `MEMORY_DISABLED` (409): the person's memory is off. */
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  /** `FACT_REJECTED` (422): the rules of what may be remembered refuse the correction; `reason` names the rule. */
  FACT_REJECTED = 'FACT_REJECTED',
  /** `MEMORY_UNAVAILABLE` (503): the memory storage of the agent is not ready. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** `AGENT_VALIDATION`: the agent did not accept the change as we sent it. */
  INVALID_REQUEST = 'INVALID_REQUEST',
}

export type UpdateAgentMemoryFactResult =
  | { success: true; fact: AgentMemoryFactResponse }
  | { success: false; error: UpdateAgentMemoryFactRequestErrorCode.FACT_REJECTED; reason: string | null }
  | {
      success: false
      error: Exclude<
        UpdateAgentMemoryFactRequestErrorCode,
        UpdateAgentMemoryFactRequestErrorCode.FACT_REJECTED
      >
    }
