import type { DialogSummaryDTO } from '../shared/dialog.dto'

export enum EndDialogOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export type EndDialogResult =
  | { success: true; summary: DialogSummaryDTO | null; saved: boolean }
  | { success: false; error: EndDialogOperationErrorCode }
