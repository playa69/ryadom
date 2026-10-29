export enum DeleteAgentMemoryFactRequestErrorCode {
  /** `MEMORY_UNAVAILABLE` (503): the agent has no disk to forget on right now. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** `AGENT_VALIDATION` (422) with `reason: unsupported_in_cognee`: this agent cannot forget a single fact. */
  UNSUPPORTED = 'UNSUPPORTED',
}

export type DeleteAgentMemoryFactResult =
  { success: true } | { success: false; error: DeleteAgentMemoryFactRequestErrorCode }
