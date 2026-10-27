/**
 * The queues of the background work and what a job in each carries (`openspec/changes/archive/2026-10-27-add-job-queue`, design D4).
 * The names and the data types live next to the service so that a typo in a name fails the compilation, in the
 * core that enqueues and in the API that works the queue off.
 *
 * A job carries identifiers only, never a text, an email or a name (design D6): its data stays in the queue's
 * table until the retention ends and may reach a backup.
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

/** The data of a job in each queue. A schedule fires with no data. */
export interface JobData {
  [JobQueue.SessionsPurgeExpired]: Record<string, never>
  [JobQueue.AccountsPurgeInactiveAnonymous]: Record<string, never>
  [JobQueue.DiaryWeeklyPass]: Record<string, never>
  [JobQueue.AnalyticsErasePerson]: { userId: string }
  [JobQueue.DialogsAfterDelete]: {
    userId: string
    dialogId: string
    /** When the conversation was held (its start, ISO 8601): its week is the one the diary resets. */
    dialogAt: string
  }
  [JobQueue.JobsWatchdog]: Record<string, never>
  /** A copy of the data of the job that failed, whatever queue it came from. */
  [JobQueue.JobsDeadLetter]: Record<string, unknown>
}

/** How long `analytics.erase-person` waits: the clients' event batches queued before the deletion land by then. */
export const ERASE_PERSON_DELAY_SECONDS = 30
/** How long `dialogs.after-delete` waits before it checks that the agent really deleted the conversation. */
export const AFTER_DELETE_DELAY_SECONDS = 120
