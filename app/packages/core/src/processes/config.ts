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
    /** Marked days of a week before its summary is written (`REQ-WELL-01`). */
    WEEK_SUMMARY_MIN_DAYS: 3,
    /** A week text is written (or rewritten) once the last mark of the week has not changed for this long: taps coalesce. */
    AUTO_QUIET_MS: 60 * 1000,
    /** Once a text exists, the background pass rewrites the current week at most this often (marks changed). The first text and the Monday close ignore it. */
    AUTO_MIN_GAP_MS: 6 * 60 * 60 * 1000,
    /** The button «Обновить итоги» can be pressed once in this long. */
    MANUAL_COOLDOWN_MS: 10 * 60 * 1000,
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
