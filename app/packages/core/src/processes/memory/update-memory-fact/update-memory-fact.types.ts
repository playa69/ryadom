import type { MemoryFactDTO } from '../shared/memory.dto'

export enum UpdateMemoryFactOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The person's memory is off: turn it on first. */
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  /** No such fact of this person (or it was forgotten already). */
  FACT_NOT_FOUND = 'FACT_NOT_FOUND',
  /** The rules of what may be remembered refuse the correction; `reason` is the code of the rule. */
  FACT_REJECTED = 'FACT_REJECTED',
  /** Memory is unavailable on the server. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** The agent did not accept the change as it was written. */
  INVALID_FACT = 'INVALID_FACT',
}

export type UpdateMemoryFactResult =
  | { success: true; fact: MemoryFactDTO }
  | { success: false; error: UpdateMemoryFactOperationErrorCode.FACT_REJECTED; reason: string | null }
  | {
      success: false
      error: Exclude<UpdateMemoryFactOperationErrorCode, UpdateMemoryFactOperationErrorCode.FACT_REJECTED>
    }
