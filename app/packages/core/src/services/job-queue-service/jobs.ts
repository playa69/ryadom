import { JobQueue } from '@ryadom/db/job-queues'

/**
 * The queues of the background work and what a job in each carries (`add-job-queue`,
 * design D4). The names live in `@ryadom/db/job-queues` (names only, no pg-boss), where the catalog of the API and the
 * admin app takes them from too, so a typo in a name fails the compilation in the core that enqueues and in every
 * process that works the queue or posts to it.
 *
 * A job carries identifiers only, never a text, an email or a name (design D6): its data stays in the queue's
 * table until the retention ends and may reach a backup.
 */
export { JobQueue, type JobQueueName } from '@ryadom/db/job-queues'

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
