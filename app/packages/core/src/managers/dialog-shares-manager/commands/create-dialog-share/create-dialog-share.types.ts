export enum CreateDialogShareCommandErrorCode {
  /** The dialog already has an active link: the person sees that one instead of making another. */
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  /** The account holds as many active links as it may. */
  LIMIT_REACHED = 'LIMIT_REACHED',
}

export type CreateDialogShareCommandResult =
  | { success: true }
  | { success: false; error: CreateDialogShareCommandErrorCode }
