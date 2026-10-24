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
    /** Final week summaries of a year before the year story is written, and how many more «Add more» needs. */
    YEAR_STORY_MIN_WEEKS: 6,
    YEAR_STORY_EXTEND_WEEKS: 4,
    /** A summary of the same period is made at most once in this long. */
    SUMMARY_COOLDOWN_MS: 24 * 60 * 60 * 1000,
    /** The finished week is closed after this local time on Monday. */
    WEEKLY_CLOSE_MINUTES: 6 * 60,
    /** The diary asks the agent for this many people at most per scheduler pass. */
    WEEKLY_PASS_LIMIT: 20,
    WEEKLY_PEOPLE_WINDOW_DAYS: 15,
    WEEKLY_PEOPLE_MAX: 500,
  },
  MOOD_REMINDER: {
    /** The window of a reminder (design D8): not before 08:00, not after 23:00, not later than 2 hours after the set time. */
    EARLIEST_MINUTES: 8 * 60,
    LATEST_MINUTES: 23 * 60,
    GRACE_MINUTES: 120,
    /** The time a person may pick: 08:00 … 22:30, every 30 minutes. */
    PICK_FROM_MINUTES: 8 * 60,
    PICK_TO_MINUTES: 22 * 60 + 30,
    PICK_STEP_MINUTES: 30,
    /** Unopened reminders in a row after which they pause. */
    PAUSE_AFTER: 7,
    /** People per page of the scheduler's pass. */
    BATCH: 500,
    /**
     * Gentle phrases, no guilt, no counting of days, never more insistent after a miss. To be approved by the
     * psychologist (add-mood-diary, task 0.3); the pick is by the local date, so one person sees one text a day.
     */
    TEXTS: [
      'Как ты сегодня? Отметь настроение в два касания',
      'Хочешь отметить, как прошёл день? Это займёт пару секунд',
      'Загляни на минутку: как ты сейчас?',
      'Если есть минутка, отметь, как ты себя чувствуешь',
      'Как день? Можно отметить настроение — Рядом будет рядом',
      'Тихий вечерний вопрос: как ты?',
    ],
    TITLE: 'Рядом',
    BUTTON: 'Отметить',
  },
} as const
