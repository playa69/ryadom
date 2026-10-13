import type { MemoryExportDTO } from '../shared/memory.dto'

export enum ExportMemoryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type ExportMemoryResult =
  { success: true; export: MemoryExportDTO } | { success: false; error: ExportMemoryOperationErrorCode }
