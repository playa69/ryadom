import type { DialogSummaryDTO } from '../shared/dialog.dto'

export enum PutRecapOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
  RECAP_NOT_AVAILABLE = 'RECAP_NOT_AVAILABLE',
}

export type PutRecapResult =
  | { success: true; summary: DialogSummaryDTO | null }
  | { success: false; error: PutRecapOperationErrorCode }
