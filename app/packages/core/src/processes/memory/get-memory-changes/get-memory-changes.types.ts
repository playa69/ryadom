import type { MemoryChangesDTO } from '../shared/memory.dto'

export enum GetMemoryChangesOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The dialog does not exist or belongs to someone else, which is the same thing to the client. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type GetMemoryChangesResult =
  { success: true; changes: MemoryChangesDTO } | { success: false; error: GetMemoryChangesOperationErrorCode }
