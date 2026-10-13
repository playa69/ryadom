import type { MemoryDTO } from '../shared/memory.dto'

export enum GetMemoryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetMemoryResult =
  { success: true; memory: MemoryDTO } | { success: false; error: GetMemoryOperationErrorCode }
