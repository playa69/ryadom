export enum StartDialogOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}

export interface StartedDialog {
  dialogId: string
  /** true means an already open dialog was returned: a person has at most one at a time. */
  resumed: boolean
  greeting: string | null
  sinceLastDialogHours: number | null
}

export type StartDialogResult =
  | { success: true; dialog: StartedDialog }
  | { success: false; error: StartDialogOperationErrorCode }
