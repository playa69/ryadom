import type { DialogRecapDTO } from '../shared/dialog.dto'

export enum DraftRecapOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
  RECAP_NOT_AVAILABLE = 'RECAP_NOT_AVAILABLE',
  UNAVAILABLE = 'UNAVAILABLE',
}

export type DraftRecapResult =
  | { success: true; recap: DialogRecapDTO }
  | { success: false; error: DraftRecapOperationErrorCode }
