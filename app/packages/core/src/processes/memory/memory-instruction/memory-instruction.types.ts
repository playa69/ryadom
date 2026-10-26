import type { MemoryNoteDTO } from '../shared/memory.dto'

export enum MemoryInstructionOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The person's memory is off: there is nothing to correct. */
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
}

export interface MemoryInstructionChangesDTO {
  added: MemoryNoteDTO[]
  updated: MemoryNoteDTO[]
  deleted: string[]
  blocked: string[]
}

export type MemoryInstructionResult =
  | { success: true; changes: MemoryInstructionChangesDTO }
  | { success: false; error: MemoryInstructionOperationErrorCode }
