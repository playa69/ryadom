export enum ForgetAgentMemoryRequestErrorCode {
  /** `MEMORY_UNAVAILABLE` (503): the agent has no disk to forget on right now. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
}

export type ForgetAgentMemoryResult =
  { success: true } | { success: false; error: ForgetAgentMemoryRequestErrorCode }
