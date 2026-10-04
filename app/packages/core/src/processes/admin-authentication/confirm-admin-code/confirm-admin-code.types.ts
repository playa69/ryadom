export enum ConfirmAdminCodeOperationErrorCode {
  /** The code is missing, did not match, was already used, or expired. */
  CODE_INVALID = 'CODE_INVALID',
  /** The fifth wrong attempt in a row: the code is burned and a new one is needed. */
  TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS',
  /** The email was removed from ADMIN_EMAILS after the code had been issued. */
  NOT_ADMIN = 'NOT_ADMIN',
}

export type ConfirmAdminCodeResult =
  | { success: true; email: string }
  | { success: false; error: ConfirmAdminCodeOperationErrorCode }
