/** Time limits and constants of the business scenarios. */
export const PROCESSES_CONFIG = {
  CODES: {
    /** Code from an email: email confirmation, password change, admin panel sign-in. */
    TTL_MINUTES: 10,
  },
  DELETION: {
    /** Who initiated the deletion, written into the personal data archive. */
    REASON_USER_REQUEST: 'user_request',
    REASON_ADMIN_REQUEST: 'admin_request',
  },
} as const
