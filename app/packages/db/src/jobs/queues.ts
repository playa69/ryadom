/**
 * The names of the queues of the background work (`add-job-queue`, design D4).
 * Names only, no pg-boss: the core re-exports them as `JobQueue` for the code that queues a job, and the API and the
 * admin app take the same names to their catalog, so a typo in a name fails the compilation everywhere.
 */
export const JobQueue = {
  /** Hourly: removes the refresh tokens that expired long ago. */
  SessionsPurgeExpired: 'sessions.purge-expired',
  /** Hourly: erases the anonymous accounts nobody has opened for the retention period. */
  AccountsPurgeInactiveAnonymous: 'accounts.purge-inactive-anonymous',
  /** Every minute: writes the diary's week texts. */
  DiaryWeeklyPass: 'diary.weekly-pass',
  /** Erases a deleted account's person in product analytics. */
  AnalyticsErasePerson: 'analytics.erase-person',
  /** After a person deleted a conversation: makes sure the week text no longer retells it. */
  DialogsAfterDelete: 'dialogs.after-delete',
  /** Every five minutes: reports a queue in trouble to the log. */
  JobsWatchdog: 'jobs.watchdog',
  /** Receives a copy of the data of a job whose retries ran out; nobody works it off. */
  JobsDeadLetter: 'jobs.dead-letter',
} as const

export type JobQueueName = (typeof JobQueue)[keyof typeof JobQueue]
