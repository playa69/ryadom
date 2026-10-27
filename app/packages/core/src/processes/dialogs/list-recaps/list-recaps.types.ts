import type { DialogRecapItemDTO } from '../shared/dialog.dto'

export enum ListRecapsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}

export type ListRecapsResult =
  | { success: true; items: DialogRecapItemDTO[]; next: string | null }
  | { success: false; error: ListRecapsOperationErrorCode }
