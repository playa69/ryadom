export enum LinkEmailOperationErrorCode {
  /** The account is gone (deleted between requests). */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The account is blocked. */
  USER_INACTIVE = 'USER_INACTIVE',
  /** The account already has a confirmed address; changing it is not part of this scenario. */
  ALREADY_HAS_EMAIL = 'ALREADY_HAS_EMAIL',
  /** The address belongs to another account. */
  EMAIL_TAKEN = 'EMAIL_TAKEN',
  /** A disposable address: nobody comes back for a confirmation sent there. */
  DISPOSABLE_EMAIL = 'DISPOSABLE_EMAIL',
}

export type LinkEmailResult =
  { success: true; email: string } | { success: false; error: LinkEmailOperationErrorCode }
