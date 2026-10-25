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
  DIARY: {
    /** Marked days of a week before «Collect the week summary» is offered (`REQ-WELL-01`). */
    WEEK_SUMMARY_MIN_DAYS: 3,
    /** A summary of the same period is made at most once in this long. */
    SUMMARY_COOLDOWN_MS: 24 * 60 * 60 * 1000,
    /** The finished week is closed after this local time on Monday. */
    WEEKLY_CLOSE_MINUTES: 6 * 60,
    /** The diary asks the agent for this many people at most per scheduler pass. */
    WEEKLY_PASS_LIMIT: 20,
    WEEKLY_PEOPLE_WINDOW_DAYS: 15,
    WEEKLY_PEOPLE_MAX: 500,
    /** A period claimed by a replica that did not finish within this long can be taken again (design D9). */
    PENDING_STALE_MS: 15 * 60 * 1000,
    /** A week text deleted with a conversation is written again if the week is at most this many weeks back. */
    RECOMPUTE_WEEKS: 5,
    /** Markers the scheduler works through in one pass. */
    RECOMPUTE_PASS_MAX: 200,
  },
} as const
