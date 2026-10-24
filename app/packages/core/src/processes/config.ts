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
    /** An anonymous account nobody opened for as long as the retention period. */
    REASON_INACTIVITY: 'anonymous_inactivity',
  },
  DIALOG_SHARE: {
    /** Links to a conversation (`REQ-DATA-05`); the same numbers as `DIALOG_SHARE_*` in contracts, which the core does not depend on. */
    MAX_ACTIVE_PER_USER: 5,
    TTL_HOURS: [24, 72, 168],
    DEFAULT_TTL_HOURS: 24,
  },
  ACTIVITY: {
    /**
     * How often the "last seen" date of one person is written at most. A session refreshes every
     * quarter of an hour and the retention period is counted in months, so an hour loses nothing.
     */
    WRITE_INTERVAL_MINUTES: 60,
  },
} as const
