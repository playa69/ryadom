import type { DialogListItemDTO } from '../shared/dialog.dto'

export enum ListDialogsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}

export type ListDialogsResult =
  | { success: true; items: DialogListItemDTO[]; next: string | null }
  | { success: false; error: ListDialogsOperationErrorCode }
