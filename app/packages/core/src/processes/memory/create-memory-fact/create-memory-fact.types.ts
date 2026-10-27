import type { MemoryFactDTO } from '../shared/memory.dto'

export enum CreateMemoryFactOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The person's memory is off: turn it on first. */
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  /** No room for another fact. */
  MEMORY_FULL = 'MEMORY_FULL',
  /** The rules of what may be remembered refuse it; `reason` is the code of the rule, never a text. */
  FACT_REJECTED = 'FACT_REJECTED',
  /** Memory is unavailable on the server. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** The agent did not accept the fact as it was written (a field too long, a wrong shape for the category). */
  INVALID_FACT = 'INVALID_FACT',
}

export type CreateMemoryFactResult =
  | { success: true; fact: MemoryFactDTO }
  | { success: false; error: CreateMemoryFactOperationErrorCode.FACT_REJECTED; reason: string | null }
  | {
      success: false
      error: Exclude<CreateMemoryFactOperationErrorCode, CreateMemoryFactOperationErrorCode.FACT_REJECTED>
    }
