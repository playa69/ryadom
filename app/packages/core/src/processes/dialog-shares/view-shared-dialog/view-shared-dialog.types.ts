import type { SharedDialogDTO } from '../shared/dialog-share.dto'

export enum ViewSharedDialogOperationErrorCode {
  /** Unknown, expired, revoked, deleted dialog, blocked owner, links off: one answer for all of them. */
  NOT_FOUND = 'NOT_FOUND',
}

export type ViewSharedDialogResult =
  | { success: true; dialog: SharedDialogDTO }
  | { success: false; error: ViewSharedDialogOperationErrorCode }
